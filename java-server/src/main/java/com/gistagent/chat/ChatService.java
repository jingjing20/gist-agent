package com.gistagent.chat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.chat.agents.SemanticDistillerService;
import com.gistagent.chat.tools.Tool;
import com.gistagent.chat.tools.ToolContext;
import com.gistagent.chat.tools.ToolExecutionResult;
import com.gistagent.chat.tools.ToolRegistry;
import com.gistagent.common.ApiException;
import com.gistagent.conversation.ConversationService;
import com.gistagent.datasource.DataSourceService;
import com.gistagent.llm.LlmService;
import com.openai.core.http.StreamResponse;
import com.openai.models.chat.completions.ChatCompletionChunk;
import com.openai.models.chat.completions.ChatCompletionCreateParams;
import com.openai.models.chat.completions.ChatCompletionMessageParam;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.stereotype.Service;

/**
 * 对话核心：编排 LLM Agent Loop，管理 SSE 流、工具调用与持久化。对齐 Nest 版
 * ChatService。全局 120s 熔断通过 {@link Future#get(long, TimeUnit)} 实现。
 */
@Service
public class ChatService {

	private static final Logger log = LoggerFactory.getLogger(ChatService.class);

	private static final int MAX_AGENT_ITERATIONS = 15;
	private static final long CHAT_TIMEOUT_MS = 120_000L;
	// 排查厂商流式 tool_call 协议差异时打开（DEBUG_TOOL_CALL_DELTA=1），生产环境关闭
	private static final boolean DEBUG_TOOL_CALL_DELTA =
			"1".equals(System.getenv("DEBUG_TOOL_CALL_DELTA"));

	private final ConversationService conversationService;
	private final DataSourceService datasourceService;
	private final LlmService llm;
	private final ToolRegistry toolRegistry;
	private final PromptBuilder promptBuilder;
	private final SemanticDistillerService distiller;
	private final ChatMessageConverter converter;
	private final ObjectMapper mapper;
	private final AsyncTaskExecutor taskExecutor;

	public ChatService(ConversationService conversationService,
					   DataSourceService datasourceService,
					   LlmService llm,
					   ToolRegistry toolRegistry,
					   PromptBuilder promptBuilder,
					   SemanticDistillerService distiller,
					   ChatMessageConverter converter,
					   ObjectMapper mapper,
					   AsyncTaskExecutor taskExecutor) {
		this.conversationService = conversationService;
		this.datasourceService = datasourceService;
		this.llm = llm;
		this.toolRegistry = toolRegistry;
		this.promptBuilder = promptBuilder;
		this.distiller = distiller;
		this.converter = converter;
		this.mapper = mapper;
		this.taskExecutor = taskExecutor;
	}

	public void handleChat(StreamEmitter emitter,
						   long userId,
						   String message,
						   String conversationId,
						   Long datasourceId) {
		Map<String, Object> conv = conversationService.findOne(conversationId, userId);
		if (conv == null) throw ApiException.forbidden("对话不存在或无权访问");

		if (datasourceId != null && !datasourceService.canAccess(datasourceId, userId)) {
			throw ApiException.forbidden("无权访问所选数据源");
		}

		conversationService.addMessage(conversationId, "user", message, List.of(), List.of());

		if ("新对话".equals(conv.get("title"))) {
			String title = message.length() > 30 ? message.substring(0, 30) + "..." : message;
			conversationService.updateTitle(conversationId, title, datasourceId);
		}

		String systemPrompt = promptBuilder.buildSystemPrompt(datasourceId, userId, conversationId);
		List<ChatMessageDto> messages = new ArrayList<>(
				promptBuilder.buildMessages(conversationId, userId, systemPrompt));

		List<SseEvent> blocks = new ArrayList<>();
		List<ChatMessageDto> turnMessages = new ArrayList<>();

		Future<Void> future = taskExecutor.submit(() -> {
			runAgentLoop(emitter, messages, turnMessages, blocks, datasourceId, userId);
			return null;
		});

		try {
			future.get(CHAT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
			emitter.done();
		} catch (TimeoutException e) {
			future.cancel(true);
			reportError(emitter, blocks, "分析超时，请尝试简化问题后重试");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause() == null ? e : e.getCause();
			log.warn("agent loop failed: {}", cause.getMessage(), cause);
			reportError(emitter, blocks, cause.getMessage() == null ? "服务异常" : cause.getMessage());
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			reportError(emitter, blocks, "请求已中断");
		}

		persistAssistantTurn(conversationId, blocks, turnMessages);

		// Fire-and-forget 语义蒸馏：失败只记日志不影响本次响应
		distiller.updateStateAsync(conversationId, userId, message);
	}

	private void reportError(StreamEmitter emitter, List<SseEvent> blocks, String message) {
		SseEvent err = SseEvent.of("error").with("content", message);
		emitter.send(err);
		blocks.add(err);
		emitter.done();
	}

	private void persistAssistantTurn(String conversationId, List<SseEvent> blocks, List<ChatMessageDto> turnMessages) {
		List<Map<String, Object>> blockPayloads = new ArrayList<>(blocks.size());
		for (SseEvent e : blocks) blockPayloads.add(e.payload());
		List<Object> llmMessages = new ArrayList<>(converter.toWireList(turnMessages));
		conversationService.addMessage(conversationId, "assistant", "", blockPayloads, llmMessages);
	}

	// --- Agent Loop ------------------------------------------------------

	private void runAgentLoop(StreamEmitter emitter,
							  List<ChatMessageDto> messages,
							  List<ChatMessageDto> turnMessages,
							  List<SseEvent> blocks,
							  Long datasourceId,
							  long userId) throws Exception {
		ToolContext ctx = new ToolContext(emitter, datasourceId, userId);

		for (int iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
			ChatCompletionCreateParams params = buildParams(messages);

			StringBuilder content = new StringBuilder();
			Map<Long, ToolCallAccumulator> accumulators = new LinkedHashMap<>();

			try (StreamResponse<ChatCompletionChunk> stream =
						 llm.getClient().chat().completions().createStreaming(params)) {
				stream.stream().forEach(chunk -> {
					if (chunk.choices().isEmpty()) return;
					var delta = chunk.choices().get(0).delta();

					delta.content().ifPresent(text -> {
						if (text.isEmpty()) return;
						content.append(text);
						emitter.send(SseEvent.of("text_chunk").with("content", text));
					});

					delta.toolCalls().ifPresent(list -> {
						for (var tc : list) {
							accumulateToolCall(tc, accumulators, emitter, blocks);
						}
					});
				});
			}

			if (content.length() > 0) {
				SseEvent last = blocks.isEmpty() ? null : blocks.get(blocks.size() - 1);
				if (last != null && "text".equals(last.type())) {
					Object existing = last.get("content");
					last.with("content", (existing == null ? "" : existing.toString()) + content);
				} else {
					blocks.add(SseEvent.of("text").with("content", content.toString()));
				}
			}

			List<ToolCallAccumulator> validCalls = new ArrayList<>(accumulators.values());
			if (validCalls.isEmpty()) {
				if (content.length() > 0) {
					ChatMessageDto finalMsg = ChatMessageDto.assistant(content.toString());
					messages.add(finalMsg);
					turnMessages.add(finalMsg);
				}
				break;
			}

			List<ToolCallDto> callDtos = new ArrayList<>(validCalls.size());
			for (ToolCallAccumulator acc : validCalls) {
				callDtos.add(new ToolCallDto(acc.id, acc.name, acc.arguments.toString()));
			}
			ChatMessageDto assistantMsg = ChatMessageDto.assistant(
					content.length() > 0 ? content.toString() : null, callDtos);
			messages.add(assistantMsg);
			turnMessages.add(assistantMsg);

			for (ToolCallAccumulator acc : validCalls) {
				String argsStr = acc.arguments.toString();
				Map<String, Object> args = parseArgs(argsStr);

				// log_update：同一轮 log 事件的“更新”。Nest 版通过找最近同 title
				// 的 log 原地改；我们保留相同语义以减少前端 diff。
				String title = "execute_sql_query".equals(acc.name)
						? "[SQL 生成]" : "[工具调用] " + acc.name;
				SseEvent existingLog = findLastLogWithTitle(blocks, title);
				if (existingLog != null) {
					String updated = "execute_sql_query".equals(acc.name)
							? "SQL 生成完毕，具体查询逻辑请查看下方SQL代码块"
							: (argsStr.isEmpty() ? "处理完毕" : argsStr);
					existingLog.with("content", updated);
					emitter.send(existingLog.asType("log_update"));
				}

				if ("execute_sql_query".equals(acc.name) && args.get("sql") != null) {
					SseEvent sqlBlock = SseEvent.of("sql").with("content", args.get("sql").toString());
					emitter.send(sqlBlock);
					blocks.add(sqlBlock);
				}

				Tool tool = toolRegistry.get(acc.name);
				String toolResult;
				if (tool == null) {
					toolResult = "工具 " + acc.name + " 不存在";
				} else {
					try {
						ToolExecutionResult r = tool.execute(args, ctx);
						toolResult = r.toolMessageContent();
						if (r.blocks() != null) blocks.addAll(r.blocks());
					} catch (Exception ex) {
						toolResult = "工具 " + acc.name + " 执行异常: " + ex.getMessage();
					}
				}

				ChatMessageDto toolMsg = ChatMessageDto.tool(acc.id, toolResult);
				messages.add(toolMsg);
				turnMessages.add(toolMsg);
			}
		}
	}

	private ChatCompletionCreateParams buildParams(List<ChatMessageDto> messages) {
		ChatCompletionCreateParams.Builder builder = ChatCompletionCreateParams.builder()
				.model(llm.getModel());
		List<ChatCompletionMessageParam> params = new ArrayList<>(messages.size());
		for (ChatMessageDto m : messages) params.add(converter.toParam(m));
		builder.messages(params);
		builder.tools(toolRegistry.getDefinitions());
		return builder.build();
	}

	private void accumulateToolCall(ChatCompletionChunk.Choice.Delta.ToolCall tc,
									Map<Long, ToolCallAccumulator> accumulators,
									StreamEmitter emitter,
									List<SseEvent> blocks) {
		if (DEBUG_TOOL_CALL_DELTA) {
			String dbgName = tc.function().flatMap(f -> f.name()).orElse("undef");
			String dbgId = tc.id().orElse("undef");
			int dbgArgsLen = tc.function().flatMap(f -> f.arguments()).map(String::length).orElse(0);
			log.info("[tool_call delta] idx={} id={} name={} args+={}",
					tc.index(), dbgId, dbgName, dbgArgsLen);
		}
		long index = tc.index();
		final ToolCallAccumulator acc = accumulators.computeIfAbsent(index, k -> {
			String name = tc.function().flatMap(f -> f.name()).orElse("");
			String id = tc.id().orElse("");
			ToolCallAccumulator created = new ToolCallAccumulator(id, name);

			String title = "execute_sql_query".equals(name) ? "[SQL 生成]" : "[工具调用] " + name;
			String initContent = "execute_sql_query".equals(name) ? "正在构思查询逻辑..." : "正在处理...";
			SseEvent callLog = SseEvent.of("log").with("title", title).with("content", initContent);
			emitter.send(callLog);
			blocks.add(callLog);

			return created;
		});
		tc.id().ifPresent(id -> {
			if (acc.id.isEmpty()) acc.id = id;
		});
		tc.function().ifPresent(f -> {
			f.name().ifPresent(name -> {
				if (acc.name.isEmpty()) acc.name = name;
			});
			f.arguments().ifPresent(acc.arguments::append);
		});
	}

	private Map<String, Object> parseArgs(String json) {
		if (json == null || json.isEmpty()) return new HashMap<>();
		try {
			return mapper.readValue(json, Map.class);
		} catch (JsonProcessingException e) {
			return new HashMap<>();
		}
	}

	private SseEvent findLastLogWithTitle(List<SseEvent> blocks, String title) {
		for (int i = blocks.size() - 1; i >= 0; i--) {
			SseEvent e = blocks.get(i);
			if ("log".equals(e.type()) && title.equals(e.get("title"))) return e;
		}
		return null;
	}

	private static final class ToolCallAccumulator {
		String id;
		String name;
		final StringBuilder arguments = new StringBuilder();

		ToolCallAccumulator(String id, String name) {
			this.id = id == null ? "" : id;
			this.name = name == null ? "" : name;
		}
	}
}

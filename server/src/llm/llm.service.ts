import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers";

@Injectable()
export class LlmService {
  readonly client: OpenAI;
  readonly model: string;

  constructor() {
    const rawClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    });
    this.client = wrapOpenAI(rawClient);
    this.model = process.env.OPENAI_MODEL || "gpt-4o";
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("LLM returned empty response");
    }
    return content;
  }

  async chatStream(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) {
        fullContent += delta;
        onChunk(delta);
      }
    }
    return fullContent;
  }
}

package com.gistagent.auth;

import com.gistagent.common.ApiException;
import com.gistagent.config.AppProperties;
import jakarta.annotation.PostConstruct;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;

/**
 * SMTP mail service. Lazy-init semantics match the Nest version: if SMTP is misconfigured, the
 * service starts fine and only throws on actual send.
 *
 * <p>JavaMailSender is injected optionally because Spring's auto-config may skip the bean when
 * spring.mail.host is empty.
 */
@Service
public class MailerService {

  private static final Logger log = LoggerFactory.getLogger(MailerService.class);

  private final JavaMailSender mailSender;
  private final AppProperties properties;
  private final String smtpHost;
  private final String smtpUser;

  public MailerService(
      ObjectProvider<JavaMailSender> mailSenderProvider,
      AppProperties properties,
      @Value("${spring.mail.host:}") String smtpHost,
      @Value("${spring.mail.username:}") String smtpUser) {
    this.mailSender = mailSenderProvider.getIfAvailable();
    this.properties = properties;
    this.smtpHost = smtpHost;
    this.smtpUser = smtpUser;
  }

  @PostConstruct
  void init() {
    if (!isConfigured()) {
      log.warn("SMTP 配置缺失，密码找回功能不可用");
    }
  }

  public void sendResetEmail(String to, String resetUrl) {
    if (!isConfigured()) {
      throw ApiException.internal("SMTP 未配置，无法发送邮件。请配置 SMTP_HOST / SMTP_USER / SMTP_PASS");
    }

    String from = resolveFromAddress();
    try {
      MimeMessage message = mailSender.createMimeMessage();
      MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
      helper.setFrom(from);
      helper.setTo(to);
      helper.setSubject("密码重置");
      helper.setText(
          "请点击以下链接重置密码（15 分钟内有效）：\n\n" + resetUrl + "\n\n若非本人操作，请忽略此邮件。",
          "<p>请点击以下链接重置密码（<b>15 分钟</b>内有效）：</p>"
              + "<p><a href=\""
              + resetUrl
              + "\">"
              + resetUrl
              + "</a></p>"
              + "<p style=\"color:#888;font-size:12px\">若非本人操作，请忽略此邮件。</p>");
      mailSender.send(message);
    } catch (Exception e) {
      log.error("发送密码重置邮件失败", e);
      throw ApiException.internal("邮件发送失败：" + e.getMessage());
    }
  }

  private boolean isConfigured() {
    return mailSender != null
        && smtpHost != null
        && !smtpHost.isBlank()
        && smtpUser != null
        && !smtpUser.isBlank();
  }

  private String resolveFromAddress() {
    String from = properties.smtp() != null ? properties.smtp().from() : null;
    if (from != null && !from.isBlank()) return from;
    return smtpUser;
  }
}

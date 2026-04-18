import logging
from email.message import EmailMessage

import aiosmtplib

from config import settings

logger = logging.getLogger(__name__)


class MailerService:
    async def send_reset_email(self, to: str, reset_url: str) -> None:
        if not settings.SMTP_HOST or not settings.SMTP_USER or not settings.SMTP_PASS:
            raise ValueError(
                "SMTP 未配置，无法发送邮件。请在 .env 中配置 SMTP_HOST / SMTP_USER / SMTP_PASS"
            )

        message = EmailMessage()
        from_email = settings.SMTP_FROM or settings.SMTP_USER
        message["From"] = from_email
        message["To"] = to
        message["Subject"] = "密码重置"

        text_content = f"请点击以下链接重置密码（15 分钟内有效）：\n\n{reset_url}\n\n若非本人操作，请忽略此邮件。"
        html_content = f"""
        <p>请点击以下链接重置密码（<b>15 分钟</b>内有效）：</p>
        <p><a href="{reset_url}">{reset_url}</a></p>
        <p style="color:#888;font-size:12px">若非本人操作，请忽略此邮件。</p>
        """

        message.set_content(text_content)
        message.add_alternative(html_content, subtype="html")

        use_tls = str(settings.SMTP_SECURE).lower() in ("true", "1", "yes")
        try:
            await aiosmtplib.send(
                message,
                hostname=settings.SMTP_HOST,
                port=settings.SMTP_PORT,
                username=settings.SMTP_USER,
                password=settings.SMTP_PASS,
                use_tls=use_tls,
            )
        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            raise RuntimeError("邮件发送失败") from e

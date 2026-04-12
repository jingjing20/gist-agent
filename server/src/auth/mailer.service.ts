import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * 邮件服务：延迟初始化 SMTP transporter。
 * 如果 SMTP 环境变量未配置，服务仍可启动，仅在实际发送时报错。
 * 避免不需要邮件功能的部署被阻塞在启动阶段
 */
@Injectable()
export class MailerService {
	private transporter: nodemailer.Transporter | null = null;
	private readonly logger = new Logger(MailerService.name);

	constructor() {
		const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
		if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
			this.logger.warn('SMTP 配置缺失，密码找回功能不可用');
			return;
		}
		this.transporter = nodemailer.createTransport({
			host: SMTP_HOST,
			port: Number(SMTP_PORT ?? 465),
			secure: SMTP_SECURE !== 'false',
			auth: { user: SMTP_USER, pass: SMTP_PASS },
		});
	}

	async sendResetEmail(to: string, resetUrl: string): Promise<void> {
		if (!this.transporter) {
			throw new Error('SMTP 未配置，无法发送邮件。请在 .env 中配置 SMTP_HOST / SMTP_USER / SMTP_PASS');
		}
		const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
		await this.transporter.sendMail({
			from,
			to,
			subject: '密码重置',
			text: `请点击以下链接重置密码（15 分钟内有效）：\n\n${resetUrl}\n\n若非本人操作，请忽略此邮件。`,
			html: `
<p>请点击以下链接重置密码（<b>15 分钟</b>内有效）：</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p style="color:#888;font-size:12px">若非本人操作，请忽略此邮件。</p>
      `.trim(),
		});
	}
}

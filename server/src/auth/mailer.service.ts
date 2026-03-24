import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailerService {
	private transporter: nodemailer.Transporter;

	constructor() {
		const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
		if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
			throw new InternalServerErrorException('SMTP 配置缺失，请检查 .env');
		}
		this.transporter = nodemailer.createTransport({
			host: SMTP_HOST,
			port: Number(SMTP_PORT ?? 465),
			secure: SMTP_SECURE !== 'false',
			auth: { user: SMTP_USER, pass: SMTP_PASS },
		});
	}

	async sendResetEmail(to: string, resetUrl: string): Promise<void> {
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

import { Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { MailerService } from './mailer.service';
import { QueryRow } from '../database/database.service';

const SALT_ROUNDS = 10;

export interface User {
    id: number;
    email: string;
    name: string;
    created_at: string;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly db: DatabaseService,
        private readonly jwt: JwtService,
        private readonly mailer: MailerService
    ) {}

    async register(email: string, password: string, name: string): Promise<{ user: User; token: string }> {
        const existing = await this.db.query<QueryRow[]>('SELECT id FROM app_user WHERE email = ?', [email.toLowerCase().trim()]);
        if (existing.length) {
            throw new ConflictException('该邮箱已注册');
        }

        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await this.db.execute('INSERT INTO app_user (email, password_hash, name) VALUES (?, ?, ?) RETURNING id', [
            email.toLowerCase().trim(),
            hash,
            (name || email.split('@')[0]).trim(),
        ]);

        const user = await this.findById(result.insertId);
        const token = this.jwt.sign({ sub: user.id, email: user.email, credentialsVersion: this.credentialsVersion(hash) });
        return { user, token };
    }

    async login(email: string, password: string): Promise<{ user: User; token: string }> {
        const rows = await this.db.query<QueryRow[]>('SELECT id, email, name, password_hash, created_at FROM app_user WHERE email = ?', [email.toLowerCase().trim()]);
        if (!rows.length) {
            throw new UnauthorizedException('邮箱或密码错误');
        }

        const row = rows[0] as any;
        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) {
            throw new UnauthorizedException('邮箱或密码错误');
        }

        const user: User = {
            id: row.id,
            email: row.email,
            name: row.name,
            created_at: row.created_at,
        };
        const token = this.jwt.sign({ sub: user.id, email: user.email, credentialsVersion: this.credentialsVersion(row.password_hash) });
        return { user, token };
    }

    async requestReset(email: string, origin?: string): Promise<void> {
        const rows = await this.db.query<QueryRow[]>('SELECT id, email FROM app_user WHERE email = ?', [email.toLowerCase().trim()]);
        if (!rows.length) return; // 不暴露邮箱是否存在

        const userId = (rows[0] as any).id;
        const token = crypto.randomBytes(32).toString('hex');

        await this.db.execute("INSERT INTO password_reset_token (user_id, token, expires_at) VALUES (?, ?, NOW() + INTERVAL '15 minutes')", [
            userId,
            this.credentialsVersion(token),
        ]);

        if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN 必须配置为公开 Web 地址');
        const base = new URL(process.env.APP_ORIGIN || origin || 'http://localhost:5173');
        if (!['http:', 'https:'].includes(base.protocol)) throw new BadRequestException('页面地址无效');
        const baseUrl = base.origin;
        const resetUrl = `${baseUrl}/reset-password?token=${token}`;
        await this.mailer.sendResetEmail(email.toLowerCase().trim(), resetUrl);
    }

    async resetPassword(token: string, newPassword: string): Promise<void> {
        if (!token?.trim()) throw new BadRequestException('token 不能为空');
        if (!newPassword || newPassword.length < 6) throw new BadRequestException('密码至少 6 位');

        await this.db.withTransaction(async (conn) => {
            const [owner] = await conn.query<QueryRow[]>('SELECT user_id FROM password_reset_token WHERE token=?', [this.credentialsVersion(token)]);
            if (!owner.length) throw new BadRequestException('链接已失效或已使用');
            await conn.query('SELECT id FROM app_user WHERE id=? FOR UPDATE', [owner[0].user_id]);
            const [rows] = await conn.query<QueryRow[]>(
                `SELECT id, user_id FROM password_reset_token
				 WHERE token = ? AND expires_at > NOW() AND used_at IS NULL FOR UPDATE`,
                [this.credentialsVersion(token)]
            );
            if (!rows.length) throw new BadRequestException('链接已失效或已使用');

            const { user_id: userId } = rows[0] as any;
            const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

            await conn.execute('UPDATE app_user SET password_hash = ? WHERE id = ?', [hash, userId]);
            await conn.execute('UPDATE password_reset_token SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [userId]);
        });
    }

    private credentialsVersion(value: string): string {
        return crypto.createHash('sha256').update(value).digest('hex');
    }

    async findById(id: number, credentialsVersion?: string): Promise<User> {
        const rows = await this.db.query<QueryRow[]>('SELECT id, email, name, created_at, password_hash FROM app_user WHERE id = ?', [id]);
        if (!rows.length) {
            throw new UnauthorizedException('用户不存在');
        }
        const row = rows[0] as any;
        if (credentialsVersion !== undefined && credentialsVersion !== this.credentialsVersion(row.password_hash)) {
            throw new UnauthorizedException('密码已变更，请重新登录');
        }
        return {
            id: row.id,
            email: row.email,
            name: row.name,
            created_at: row.created_at,
        };
    }
}

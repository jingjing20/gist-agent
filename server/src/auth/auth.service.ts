import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '../database/database.service';
import { RowDataPacket } from 'mysql2/promise';

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
	) { }

	async register(email: string, password: string, name: string): Promise<{ user: User; token: string }> {
		const existing = await this.db.query<RowDataPacket[]>(
			'SELECT id FROM user WHERE email = ?',
			[email.toLowerCase().trim()],
		);
		if (existing.length) {
			throw new ConflictException('该邮箱已注册');
		}

		const hash = await bcrypt.hash(password, SALT_ROUNDS);
		const result = await this.db.execute(
			'INSERT INTO user (email, password_hash, name) VALUES (?, ?, ?)',
			[email.toLowerCase().trim(), hash, (name || email.split('@')[0]).trim()],
		);

		const user = await this.findById(result.insertId);
		const token = this.jwt.sign({ sub: user.id, email: user.email });
		return { user, token };
	}

	async login(email: string, password: string): Promise<{ user: User; token: string }> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id, email, name, password_hash FROM user WHERE email = ?',
			[email.toLowerCase().trim()],
		);
		if (!rows.length) {
			throw new UnauthorizedException('邮箱或密码错误');
		}

		const row = rows[0] as any;
		const ok = await bcrypt.compare(password, row.password_hash);
		if (!ok) {
			throw new UnauthorizedException('邮箱或密码错误');
		}

		const user: User = { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
		const token = this.jwt.sign({ sub: user.id, email: user.email });
		return { user, token };
	}

	async findById(id: number): Promise<User> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id, email, name, created_at FROM user WHERE id = ?',
			[id],
		);
		if (!rows.length) {
			throw new UnauthorizedException('用户不存在');
		}
		const row = rows[0] as any;
		return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
	}
}

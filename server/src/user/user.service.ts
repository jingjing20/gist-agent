import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RowDataPacket } from 'mysql2/promise';

@Injectable()
export class UserService {
	constructor(private readonly db: DatabaseService) { }

	async searchByEmail(q: string, limit = 20): Promise<{ id: number; email: string; name: string }[]> {
		if (!q?.trim() || q.length < 2) return [];
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id, email, name FROM user WHERE email LIKE ? ORDER BY email LIMIT ?',
			[`%${q.trim()}%`, limit],
		);
		return rows as unknown as { id: number; email: string; name: string }[];
	}
}

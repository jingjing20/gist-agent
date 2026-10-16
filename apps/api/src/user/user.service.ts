import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QueryRow } from '../database/database.service';
import * as bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;
@Injectable()
export class UserService {
    constructor(private readonly db: DatabaseService) {}

    async searchByEmail(q: string, limit = 20): Promise<{ id: number; email: string; name: string }[]> {
        if (!q?.trim() || q.length < 2) return [];
        const rows = await this.db.query<QueryRow[]>('SELECT id, email, name FROM app_user WHERE email ILIKE ? ORDER BY email LIMIT ?', [`%${q.trim()}%`, limit]);
        return rows as unknown as { id: number; email: string; name: string }[];
    }

    async updateProfile(userId: number, name: string): Promise<void> {
        if (!name?.trim()) throw new Error('用户名不能为空');
        await this.db.execute('UPDATE app_user SET name = ? WHERE id = ?', [name.trim(), userId]);
    }

    async updatePassword(userId: number, newPassword: string, currentPassword: string): Promise<void> {
        if (!newPassword || newPassword.length < 6) throw new BadRequestException('密码至少 6 位');
        if (!currentPassword) throw new BadRequestException('请输入当前密码');
        const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await this.db.withTransaction(async (tx) => {
            const [rows] = await tx.query<QueryRow[]>('SELECT password_hash FROM app_user WHERE id=? FOR UPDATE', [userId]);
            if (!rows.length || !(await bcrypt.compare(currentPassword, String(rows[0].password_hash)))) {
                throw new UnauthorizedException('当前密码错误');
            }
            await tx.execute('UPDATE app_user SET password_hash=? WHERE id=?', [hash, userId]);
            await tx.execute('UPDATE password_reset_token SET used_at=NOW() WHERE user_id=? AND used_at IS NULL', [userId]);
        });
    }
}

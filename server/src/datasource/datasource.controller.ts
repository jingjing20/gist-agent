import {
	Controller, Get, Post, Delete, Param, Body, ParseIntPipe,
	UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DataSourceService } from './datasource.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';
import csvParser = require('csv-parser');
import { Readable } from 'stream';
import * as XLSX from 'xlsx';

const MAX_FILE_ROWS = 50_000;

function inferMysqlType(values: unknown[]): string {
	const sample = values.find(v => v !== null && v !== undefined && v !== '');
	if (sample === undefined) return 'TEXT';
	if (typeof sample === 'number' || (!isNaN(Number(sample)) && String(sample).trim() !== '')) {
		return String(sample).includes('.') ? 'DOUBLE' : 'BIGINT';
	}
	return 'TEXT';
}

function ensureUniqueColumnNames(rawNames: string[]): string[] {
	const sanitize = (s: string) =>
		(s.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').replace(/^_+|_+$/g, '') || 'col');
	const seen = new Map<string, number>();
	return rawNames.map((raw) => {
		let name = sanitize(raw);
		const count = seen.get(name) ?? 0;
		seen.set(name, count + 1);
		return count === 0 ? name : `${name}_${count}`;
	});
}

@Controller('datasources')
export class DataSourceController {
	constructor(private readonly datasourceService: DataSourceService) { }

	@Get()
	findAll(@CurrentUser() user: User) {
		return this.datasourceService.findAllForUser(user.id);
	}

	@Get(':id/tables')
	listTables(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
		return this.datasourceService.listUploadedTables(id, user.id);
	}

	@Post(':id/tables')
	@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
	async uploadTable(
		@CurrentUser() user: User,
		@Param('id', ParseIntPipe) datasourceId: number,
		@UploadedFile() file: Express.Multer.File,
		@Body('displayName') displayName: string,
	) {
		if (!file) throw new BadRequestException('请上传文件');
		if (!displayName?.trim()) throw new BadRequestException('请提供表名');

		const ext = file.originalname.split('.').pop()?.toLowerCase();
		let rawRows: Record<string, unknown>[] = [];

		if (ext === 'csv') {
			rawRows = await new Promise((resolve, reject) => {
				const results: Record<string, unknown>[] = [];
				const readable = Readable.from(file.buffer);
				const csvStream = readable.pipe(csvParser());
				csvStream
					.on('data', (row: Record<string, unknown>) => {
						results.push(row);
						if (results.length > MAX_FILE_ROWS) {
							readable.destroy();
							csvStream.destroy();
							reject(new BadRequestException(`文件行数超过上限 ${MAX_FILE_ROWS} 行，请分批上传或裁剪后重试`));
						}
					})
					.on('end', () => resolve(results))
					.on('error', reject);
			});
		} else if (ext === 'xlsx' || ext === 'xls') {
			const workbook = XLSX.read(file.buffer, { type: 'buffer' });
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null }) as Record<string, unknown>[];
			if (rawRows.length > MAX_FILE_ROWS) {
				throw new BadRequestException(`文件行数超过上限 ${MAX_FILE_ROWS} 行，请分批上传或裁剪后重试`);
			}
		} else {
			throw new BadRequestException('只支持 .csv / .xlsx / .xls 格式');
		}

		if (!rawRows.length) throw new BadRequestException('文件内容为空');

		const colNames = Object.keys(rawRows[0]);
		const uniqueNames = ensureUniqueColumnNames(colNames);
		const columns = colNames.map((colName, i) => ({
			name: uniqueNames[i],
			type: inferMysqlType(rawRows.map(r => r[colName])),
		}));

		const cleanRows = rawRows.map(row => {
			const cleaned: Record<string, unknown> = {};
			colNames.forEach((orig, i) => { cleaned[columns[i].name] = row[orig]; });
			return cleaned;
		});

		return this.datasourceService.uploadTable(datasourceId, user.id, displayName.trim(), columns, cleanRows);
	}

	@Delete(':id/tables/:tableId')
	async deleteTable(
		@CurrentUser() user: User,
		@Param('tableId', ParseIntPipe) tableId: number,
	) {
		await this.datasourceService.deleteUploadedTable(tableId, user.id);
		return { ok: true };
	}

	@Get(':id')
	findOne(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
		return this.datasourceService.findOne(id, user.id);
	}

	@Post()
	create(@CurrentUser() user: User, @Body() body: {
		name: string;
		host: string;
		port: number;
		user: string;
		password: string;
		database_name: string;
		description?: string;
	}) {
		return this.datasourceService.create(user.id, body);
	}

	@Delete(':id')
	remove(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
		return this.datasourceService.remove(id, user.id);
	}

	@Post(':id/test')
	test(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
		return this.datasourceService.testById(id, user.id);
	}

	@Post(':id/grant')
	async grant(
		@CurrentUser() user: User,
		@Param('id', ParseIntPipe) id: number,
		@Body() body: { userId: number },
	) {
		if (!body.userId) throw new BadRequestException('请提供 userId');
		await this.datasourceService.grant(id, body.userId, user.id);
		return { ok: true };
	}

	@Post(':id/revoke')
	async revoke(
		@CurrentUser() user: User,
		@Param('id', ParseIntPipe) id: number,
		@Body() body: { userId: number },
	) {
		if (!body.userId) throw new BadRequestException('请提供 userId');
		await this.datasourceService.revoke(id, body.userId, user.id);
		return { ok: true };
	}

	@Get(':id/permissions')
	listPermissions(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
		return this.datasourceService.listPermissionUsers(id, user.id);
	}
}

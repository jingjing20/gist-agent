import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DataSourceService } from './datasource.service';
import { SuggestionService } from './suggestion.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';
import csvParser = require('csv-parser');
import { Readable } from 'stream';
import * as XLSX from 'xlsx';

const MAX_FILE_ROWS = 50_000;

const NUMERIC_RE = /^-?(\d+\.?\d*|\d*\.\d+)$/;
const THOUSAND_SEP_RE = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * 数据清洗：统一处理从 CSV/Excel 读入的原始值。
 * - 清除零宽字符和 BOM 标记
 * - 去除千分位分隔符 (如 "1,234.56" -> "1234.56")
 * - 空白/空字符串统一为 null（避免 MySQL 存入空串导致类型推断失效）
 */
function normalizeValue(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
        let s = v.replace(/[\u200B\uFEFF\u00A0]/g, ' ').trim();
        if (s === '') return null;
        if (THOUSAND_SEP_RE.test(s)) {
            s = s.replace(/,/g, '');
        }
        return s;
    }
    return v;
}

function isNumeric(v: unknown): boolean {
    if (typeof v === 'number') return isFinite(v);
    if (typeof v === 'string') return NUMERIC_RE.test(v);
    return false;
}

/**
 * 全列值扫描推断 MySQL 类型。
 * 策略：全部非空值都是数字 -> BIGINT/DOUBLE，否则 TEXT。
 * 宁可宽泛（TEXT）也不误判数字导致插入失败
 */
function inferMysqlType(values: unknown[]): string {
    const nonNull = values.filter((v) => v !== null);
    if (nonNull.length === 0) return 'TEXT';
    if (!nonNull.every(isNumeric)) return 'TEXT';
    const hasDecimal = nonNull.some((v) => (typeof v === 'number' ? !Number.isInteger(v) : String(v).includes('.')));
    return hasDecimal ? 'DOUBLE' : 'BIGINT';
}

function coerce(value: unknown, type: string): unknown {
    if (value === null) return null;
    if (type === 'TEXT') return value;
    if (typeof value === 'number') return value;
    const n = parseFloat(value as string);
    return isFinite(n) ? n : null;
}

/**
 * 列名清洗 + 去重：
 * 1. 特殊字符替换为下划线（保留中文）
 * 2. 重复列名追加后缀 _1, _2...
 * Excel/CSV 经常出现空列名或重复列名，不处理会导致 CREATE TABLE 失败
 */
function ensureUniqueColumnNames(rawNames: string[]): string[] {
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').replace(/^_+|_+$/g, '') || 'col';
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
    constructor(
        private readonly datasourceService: DataSourceService,
        private readonly suggestionService: SuggestionService
    ) {}

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
        @Body('tableConfigs') tableConfigsStr: string
    ) {
        if (!file) throw new BadRequestException('请上传文件');
        if (!tableConfigsStr) throw new BadRequestException('缺失表配置信息');

        let tableConfigs: { sheetName?: string; displayName: string }[] = [];
        try {
            tableConfigs = JSON.parse(tableConfigsStr);
        } catch (e) {
            throw new BadRequestException('表配置格式错误');
        }

        if (!tableConfigs.length) throw new BadRequestException('请选择至少一个要上传的表');

        const ext = file.originalname.split('.').pop()?.toLowerCase();
        const results: any[] = [];

        let workbook: XLSX.WorkBook | null = null;
        if (ext === 'xlsx' || ext === 'xls') {
            workbook = XLSX.read(file.buffer, { type: 'buffer' });
        }

        for (const config of tableConfigs) {
            let rawRows: Record<string, unknown>[] = [];
            const displayName = config.displayName.trim();
            if (!displayName) continue;

            if (ext === 'csv') {
                rawRows = await new Promise((resolve, reject) => {
                    const rows: Record<string, unknown>[] = [];
                    const readable = Readable.from(file.buffer);
                    const csvStream = readable.pipe(csvParser());
                    csvStream
                        .on('data', (row: Record<string, unknown>) => {
                            rows.push(row);
                            if (rows.length > MAX_FILE_ROWS) {
                                readable.destroy();
                                csvStream.destroy();
                                reject(new BadRequestException(`文件行数超过上限 ${MAX_FILE_ROWS} 行`));
                            }
                        })
                        .on('end', () => resolve(rows))
                        .on('error', reject);
                });
            } else if (workbook) {
                const sheetName = config.sheetName || workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                if (!sheet) continue;
                rawRows = XLSX.utils.sheet_to_json(sheet, {
                    defval: null,
                    raw: true,
                }) as Record<string, unknown>[];
                if (rawRows.length > MAX_FILE_ROWS) {
                    throw new BadRequestException(`Sheet「${sheetName}」行数超过上限 ${MAX_FILE_ROWS} 行`);
                }
            }

            if (!rawRows.length) continue;

            const colNames = Object.keys(rawRows[0]);
            const normalizedRows = rawRows.map((row) => {
                const out: Record<string, unknown> = {};
                for (const key of colNames) out[key] = normalizeValue(row[key]);
                return out;
            });

            const uniqueNames = ensureUniqueColumnNames(colNames);
            const columns = colNames.map((colName, i) => ({
                name: uniqueNames[i],
                originalName: colName,
                type: inferMysqlType(normalizedRows.map((r) => r[colName])),
            }));

            const cleanRows = normalizedRows.map((row) => {
                const cleaned: Record<string, unknown> = {};
                colNames.forEach((orig, i) => {
                    cleaned[columns[i].name] = coerce(row[orig], columns[i].type);
                });
                return cleaned;
            });

            const result = await this.datasourceService.uploadTable(datasourceId, user.id, displayName, columns, cleanRows);
            results.push(result);
        }

        if (results.length > 0) {
            this.suggestionService.invalidateAndRegenerate(datasourceId, user.id);
        }

        return results;
    }

    @Delete(':id/tables/:tableId')
    async deleteTable(@CurrentUser() user: User, @Param('tableId', ParseIntPipe) tableId: number) {
        const dsId = await this.datasourceService.deleteUploadedTable(tableId, user.id);
        if (dsId) this.suggestionService.invalidateAndRegenerate(dsId, user.id);
        return { ok: true };
    }

    @Get(':id/suggestions')
    async getSuggestions(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        const questions = await this.suggestionService.getSuggestions(id, user.id);
        return { questions };
    }

    @Get(':id/schema')
    async getSchema(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        return this.datasourceService['schemaService'].getStructuredSchema(id, user.id);
    }

    @Get(':id')
    findOne(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        return this.datasourceService.findOne(id, user.id);
    }

    @Post()
    async create(
        @CurrentUser() user: User,
        @Body()
        body: {
            name: string;
            description?: string;
        }
    ) {
        if (!body.name?.trim()) throw new BadRequestException('请提供数据源名称');
        return this.datasourceService.create(user.id, body);
    }

    @Post(':id/grant')
    async grant(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number, @Body() body: { userId: number }) {
        if (!body.userId) throw new BadRequestException('请提供 userId');
        await this.datasourceService.grant(id, body.userId, user.id);
        return { ok: true };
    }

    @Post(':id/revoke')
    async revoke(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number, @Body() body: { userId: number }) {
        if (!body.userId) throw new BadRequestException('请提供 userId');
        await this.datasourceService.revoke(id, body.userId, user.id);
        return { ok: true };
    }

    @Get(':id/permissions')
    listPermissions(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        return this.datasourceService.listPermissionUsers(id, user.id);
    }

    @Patch(':id')
    async update(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number, @Body() body: { name?: string; description?: string }) {
        if (body.name !== undefined && !body.name.trim()) {
            throw new BadRequestException('数据源名称不能为空');
        }
        return this.datasourceService.update(id, user.id, body);
    }

    @Delete(':id')
    remove(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        return this.datasourceService.remove(id, user.id);
    }
}

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

async function initDB() {
	const conn = await mysql.createConnection({
		host: DB_HOST,
		port: Number(DB_PORT),
		user: DB_USER,
		password: DB_PASSWORD,
		multipleStatements: true,
	});

	await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
	await conn.query(`USE \`${DB_NAME}\``);

	// user 表：用户账号
	await conn.query(`
    CREATE TABLE IF NOT EXISTS user (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱',
      password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希',
      name VARCHAR(100) NOT NULL DEFAULT '' COMMENT '昵称',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) COMMENT='用户表';
  `);

	// data_source 表：管理所有数据源连接配置
	// is_local=1 表示系统默认本地库，不允许前端删除，所有人可用
	await conn.query(`
    CREATE TABLE IF NOT EXISTS data_source (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL COMMENT '数据源名称',
      host VARCHAR(255) COMMENT '数据库主机',
      port INT COMMENT '端口',
      user VARCHAR(100) COMMENT '用户名',
      password VARCHAR(255) COMMENT '密码（明文，生产环境应加密）',
      database_name VARCHAR(100) COMMENT '数据库名',
      is_local TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=系统默认本地库，不可删除',
      created_by INT NULL COMMENT '创建人 user.id，NULL=系统数据源所有人可访问',
      description VARCHAR(255) COMMENT '备注',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES user(id) ON DELETE SET NULL
    ) COMMENT='数据源配置';
  `);

	// uploaded_table 表：用户上传的文件表（归属于某个数据源）
	await conn.query(`
    CREATE TABLE IF NOT EXISTS uploaded_table (
      id INT PRIMARY KEY AUTO_INCREMENT,
      datasource_id INT NOT NULL COMMENT '所属数据源',
      user_id INT NOT NULL COMMENT '上传人',
      table_name VARCHAR(100) NOT NULL COMMENT '实际表名（如 ut_1234567890）',
      display_name VARCHAR(100) NOT NULL COMMENT '用户指定的显示名',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (datasource_id) REFERENCES data_source(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      UNIQUE KEY uk_ds_table (datasource_id, table_name)
    ) COMMENT='用户上传的文件表';
  `);

	// datasource_permission 表：数据源访问权限（创建人自动有权限，可授权他人）
	await conn.query(`
    CREATE TABLE IF NOT EXISTS datasource_permission (
      id INT PRIMARY KEY AUTO_INCREMENT,
      datasource_id INT NOT NULL,
      user_id INT NOT NULL,
      granted_by INT NULL COMMENT '授权人 user.id',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_ds_user (datasource_id, user_id),
      FOREIGN KEY (datasource_id) REFERENCES data_source(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES user(id) ON DELETE SET NULL
    ) COMMENT='数据源权限';
  `);

	// 迁移：为已有 data_source 表添加 created_by（若不存在）
	try {
		const [cols] = await conn.query<any[]>(
			"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'data_source' AND COLUMN_NAME = 'created_by'",
			[DB_NAME],
		);
		if (!cols?.length) {
			await conn.query('ALTER TABLE data_source ADD COLUMN created_by INT NULL COMMENT "创建人" AFTER is_local');
		}
	} catch { /* ignore */ }

	// 插入本地默认数据源（幂等：只在不存在时插入）
	await conn.query(`
    INSERT INTO data_source (name, host, port, user, password, database_name, is_local, description)
    SELECT '本地默认库', ?, ?, ?, ?, ?, 1, '系统初始化的本地开发数据库，所有用户可用于上传文件分析'
    WHERE NOT EXISTS (SELECT 1 FROM data_source WHERE is_local = 1)
  `, [DB_HOST, Number(DB_PORT), DB_USER, DB_PASSWORD, DB_NAME]);

	await conn.query(`
    DROP TABLE IF EXISTS user_behavior_log;
    DROP TABLE IF EXISTS daily_active_stats;
    DROP TABLE IF EXISTS platform_info;
  `);

	await conn.query(`
    CREATE TABLE platform_info (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL COMMENT '平台名称',
      owner VARCHAR(50) NOT NULL COMMENT '负责人',
      description VARCHAR(200) COMMENT '平台描述',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) COMMENT='平台信息维表';
  `);

	await conn.query(`
    CREATE TABLE daily_active_stats (
      id INT PRIMARY KEY AUTO_INCREMENT,
      date DATE NOT NULL COMMENT '统计日期',
      platform_id INT NOT NULL COMMENT '平台ID',
      dau INT NOT NULL COMMENT '日活跃用户数',
      new_users INT NOT NULL COMMENT '新增用户数',
      avg_duration_min DECIMAL(6,1) NOT NULL COMMENT '平均使用时长(分钟)',
      FOREIGN KEY (platform_id) REFERENCES platform_info(id),
      UNIQUE KEY uk_date_platform (date, platform_id)
    ) COMMENT='平台日活统计表';
  `);

	await conn.query(`
    CREATE TABLE user_behavior_log (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id VARCHAR(32) NOT NULL COMMENT '用户ID',
      platform_id INT NOT NULL COMMENT '平台ID',
      action VARCHAR(30) NOT NULL COMMENT '行为类型: view/click/search/share/download',
      target VARCHAR(100) COMMENT '行为对象',
      created_at DATETIME NOT NULL COMMENT '行为时间',
      FOREIGN KEY (platform_id) REFERENCES platform_info(id),
      INDEX idx_platform_time (platform_id, created_at),
      INDEX idx_user (user_id)
    ) COMMENT='用户行为明细日志';
  `);

	// 插入平台数据
	await conn.query(`
    INSERT INTO platform_info (id, name, owner, description) VALUES
    (1, '天河', '张明', '企业级数据分析平台，提供多维度数据洞察'),
    (2, '星河', '李婷', '智能营销平台，支持精准用户触达'),
    (3, '云海', '王强', '内容管理平台，支持多渠道内容分发');
  `);

	// 生成近 90 天的日活数据
	const dailyRows: string[] = [];
	const now = new Date();
	for (let i = 89; i >= 0; i--) {
		const date = new Date(now);
		date.setDate(date.getDate() - i);
		const dateStr = date.toISOString().split('T')[0];
		const dayOfWeek = date.getDay();
		const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

		for (const platformId of [1, 2, 3]) {
			const baseDAU = platformId === 1 ? 12000 : platformId === 2 ? 8000 : 5000;
			const weekendFactor = isWeekend ? 0.65 : 1;
			const trendFactor = 1 + (90 - i) * 0.002; // 轻微增长趋势
			const noise = 0.9 + Math.random() * 0.2;
			const dau = Math.round(baseDAU * weekendFactor * trendFactor * noise);

			const newUserBase = platformId === 1 ? 300 : platformId === 2 ? 200 : 120;
			const newUsers = Math.round(newUserBase * weekendFactor * noise);

			const avgDuration = platformId === 1 ? 25 : platformId === 2 ? 18 : 32;
			const duration = (avgDuration * (0.85 + Math.random() * 0.3)).toFixed(1);

			dailyRows.push(`('${dateStr}', ${platformId}, ${dau}, ${newUsers}, ${duration})`);
		}
	}

	// 分批插入
	const BATCH_SIZE = 50;
	for (let i = 0; i < dailyRows.length; i += BATCH_SIZE) {
		const batch = dailyRows.slice(i, i + BATCH_SIZE);
		await conn.query(`
      INSERT INTO daily_active_stats (date, platform_id, dau, new_users, avg_duration_min) VALUES ${batch.join(',')};
    `);
	}

	// 生成用户行为数据（最近 30 天，采样）
	const actions = ['view', 'click', 'search', 'share', 'download'];
	const targets = [
		'首页', '数据报表', '用户分析', '趋势图', '导出功能',
		'搜索页', '详情页', '设置页', '帮助文档', '通知中心',
	];
	const behaviorRows: string[] = [];

	for (let i = 29; i >= 0; i--) {
		const date = new Date(now);
		date.setDate(date.getDate() - i);
		const dateStr = date.toISOString().split('T')[0];

		// 每天每个平台采样 20 条行为
		for (const platformId of [1, 2, 3]) {
			for (let j = 0; j < 20; j++) {
				const userId = `U${String(Math.floor(Math.random() * 500) + 1).padStart(5, '0')}`;
				const action = actions[Math.floor(Math.random() * actions.length)];
				const target = targets[Math.floor(Math.random() * targets.length)];
				const hour = Math.floor(Math.random() * 14) + 8; // 8-22 点
				const minute = Math.floor(Math.random() * 60);
				const ts = `${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
				behaviorRows.push(`('${userId}', ${platformId}, '${action}', '${target}', '${ts}')`);
			}
		}
	}

	for (let i = 0; i < behaviorRows.length; i += BATCH_SIZE) {
		const batch = behaviorRows.slice(i, i + BATCH_SIZE);
		await conn.query(`
      INSERT INTO user_behavior_log (user_id, platform_id, action, target, created_at) VALUES ${batch.join(',')};
    `);
	}

	console.log('Database initialized successfully.');
	console.log(`  - platform_info: 3 rows`);
	console.log(`  - daily_active_stats: ${dailyRows.length} rows`);
	console.log(`  - user_behavior_log: ${behaviorRows.length} rows`);

	await conn.end();
}

initDB().catch((err) => {
	console.error('Failed to initialize database:', err);
	process.exit(1);
});

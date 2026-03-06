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

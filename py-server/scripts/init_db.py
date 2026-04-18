import asyncio
import random
from datetime import datetime, timedelta

import aiomysql

from src.config import settings

async def init_db():
    conn = await aiomysql.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        autocommit=True,
    )
    
    async with conn.cursor() as cur:
        await cur.execute(f"CREATE DATABASE IF NOT EXISTS `{settings.DB_NAME}`")
        await cur.execute(f"USE `{settings.DB_NAME}`")

        # user 表：用户账号
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS user (
            id INT PRIMARY KEY AUTO_INCREMENT,
            email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱',
            password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希',
            name VARCHAR(100) NOT NULL DEFAULT '' COMMENT '昵称',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) COMMENT='用户表';
        """)

        # data_source 表
        await cur.execute("""
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
        """)

        # uploaded_table 表
        await cur.execute("""
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
        """)

        # datasource_permission 表
        await cur.execute("""
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
        """)

        # datasource_suggestions 表
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS datasource_suggestions (
            datasource_id INT NOT NULL,
            user_id INT NOT NULL,
            questions JSON NOT NULL COMMENT '推荐问题列表',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (datasource_id, user_id),
            FOREIGN KEY (datasource_id) REFERENCES data_source(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
        ) COMMENT='数据源推荐问题缓存';
        """)

        # password_reset_token 表
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS password_reset_token (
            id         INT PRIMARY KEY AUTO_INCREMENT,
            user_id    INT NOT NULL,
            token      VARCHAR(64) NOT NULL UNIQUE COMMENT 'crypto.randomBytes(32) hex',
            expires_at DATETIME NOT NULL COMMENT '15 分钟有效',
            used_at    DATETIME NULL COMMENT '非 NULL 表示已使用',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
            INDEX idx_token (token)
        ) COMMENT='密码重置 Token';
        """)

        # conversation 表
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS conversation (
            id VARCHAR(36) PRIMARY KEY,
            user_id INT NULL COMMENT 'NULL=迁移遗留，不展示',
            datasource_id INT NULL COMMENT '关联的数据源',
            title VARCHAR(200) NOT NULL DEFAULT '新对话',
            semantic_state JSON NULL COMMENT 'Semantic Summary',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
        ) COMMENT='对话';
        """)

        # message 表
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS message (
            id VARCHAR(36) PRIMARY KEY,
            conversation_id VARCHAR(36) NOT NULL,
            role ENUM('user', 'assistant') NOT NULL,
            content TEXT,
            blocks JSON,
            llm_messages JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE,
            INDEX idx_conv_time (conversation_id, created_at)
        ) COMMENT='消息';
        """)

        # message_block 表
        await cur.execute("""
        CREATE TABLE IF NOT EXISTS message_block (
            id VARCHAR(36) PRIMARY KEY,
            message_id VARCHAR(36) NOT NULL,
            sort_order INT NOT NULL,
            type VARCHAR(30) NOT NULL,
            content TEXT,
            metadata JSON,
            FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
            INDEX idx_message_blocks (message_id, sort_order)
        ) COMMENT='消息块';
        """)

        # 插入本地默认数据源
        await cur.execute("""
        INSERT INTO data_source (name, host, port, user, password, database_name, is_local, description)
        SELECT '本地默认库', %s, %s, %s, %s, %s, 1, '系统初始化的本地开发数据库，所有用户可用于上传文件分析'
        WHERE NOT EXISTS (SELECT 1 FROM data_source WHERE is_local = 1)
        """, (settings.DB_HOST, settings.DB_PORT, settings.DB_USER, settings.DB_PASSWORD, settings.DB_NAME))

        await cur.execute("DROP TABLE IF EXISTS user_behavior_log;")
        await cur.execute("DROP TABLE IF EXISTS daily_active_stats;")
        await cur.execute("DROP TABLE IF EXISTS platform_info;")

        await cur.execute("""
        CREATE TABLE platform_info (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(50) NOT NULL COMMENT '平台名称',
            owner VARCHAR(50) NOT NULL COMMENT '负责人',
            description VARCHAR(200) COMMENT '平台描述',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) COMMENT='平台信息维表';
        """)

        await cur.execute("""
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
        """)

        await cur.execute("""
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
        """)

        # 插入平台数据
        await cur.execute("""
        INSERT INTO platform_info (id, name, owner, description) VALUES
        (1, '天河', '张明', '企业级数据分析平台，提供多维度数据洞察'),
        (2, '星河', '李婷', '智能营销平台，支持精准用户触达'),
        (3, '云海', '王强', '内容管理平台，支持多渠道内容分发');
        """)

        # 生成近 90 天的日活数据
        daily_rows = []
        now = datetime.now()
        for i in range(89, -1, -1):
            date_obj = now - timedelta(days=i)
            date_str = date_obj.strftime("%Y-%m-%d")
            day_of_week = date_obj.weekday()
            is_weekend = day_of_week >= 5

            for platform_id in [1, 2, 3]:
                base_dau = 12000 if platform_id == 1 else (8000 if platform_id == 2 else 5000)
                weekend_factor = 0.65 if is_weekend else 1.0
                trend_factor = 1 + (90 - i) * 0.002
                noise = 0.9 + random.random() * 0.2
                dau = round(base_dau * weekend_factor * trend_factor * noise)

                new_user_base = 300 if platform_id == 1 else (200 if platform_id == 2 else 120)
                new_users = round(new_user_base * weekend_factor * noise)

                avg_duration = 25 if platform_id == 1 else (18 if platform_id == 2 else 32)
                duration = round(avg_duration * (0.85 + random.random() * 0.3), 1)

                daily_rows.append(f"('{date_str}', {platform_id}, {dau}, {new_users}, {duration})")

        batch_size = 50
        for i in range(0, len(daily_rows), batch_size):
            batch = daily_rows[i:i + batch_size]
            await cur.execute(f"INSERT INTO daily_active_stats (date, platform_id, dau, new_users, avg_duration_min) VALUES {','.join(batch)};")


        # 生成用户行为数据（最近 30 天，采样）
        actions = ['view', 'click', 'search', 'share', 'download']
        targets = [
            '首页', '数据报表', '用户分析', '趋势图', '导出功能',
            '搜索页', '详情页', '设置页', '帮助文档', '通知中心',
        ]
        behavior_rows = []
        for i in range(29, -1, -1):
            date_obj = now - timedelta(days=i)
            date_str = date_obj.strftime("%Y-%m-%d")

            for platform_id in [1, 2, 3]:
                for _ in range(20):
                    user_id = f"U{str(random.randint(1, 500)).zfill(5)}"
                    action = random.choice(actions)
                    target = random.choice(targets)
                    hour = random.randint(8, 21)
                    minute = random.randint(0, 59)
                    ts = f"{date_str} {str(hour).zfill(2)}:{str(minute).zfill(2)}:00"
                    behavior_rows.append(f"('{user_id}', {platform_id}, '{action}', '{target}', '{ts}')")

        for i in range(0, len(behavior_rows), batch_size):
            batch = behavior_rows[i:i + batch_size]
            await cur.execute(f"INSERT INTO user_behavior_log (user_id, platform_id, action, target, created_at) VALUES {','.join(batch)};")

        print("Database initialized successfully.")
        print("  - platform_info: 3 rows")
        print(f"  - daily_active_stats: {len(daily_rows)} rows")
        print(f"  - user_behavior_log: {len(behavior_rows)} rows")

    conn.close()
    await conn.wait_closed()


if __name__ == "__main__":
    asyncio.run(init_db())

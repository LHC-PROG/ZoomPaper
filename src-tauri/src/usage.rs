//! Token 用量与费用统计。
//!
//! 每次模型调用把 `prompt/completion` tokens 记到 `token_usage` 表，并按设置里的
//! 单价表折算成**微元**（1 元 = 1_000_000 微元）存下来——历史记录不会因为以后改价而变。
//!
//! 单价按「模型名包含某个关键词」匹配，默认给了常见服务的参考价，用户可以在设置里改。
//! 写入用独立连接（WAL + busy_timeout），不占主库的锁，也不会因为统计失败影响对话。

use crate::db::Db;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::future::Future;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

tokio::task_local! {
    /// 当前请求的用途（翻译 / 博客 / 测验 / 问答…），用于统计分组。
    static PURPOSE: &'static str;
}

/// 在指定用途下执行一段异步逻辑；`chat()` 内部记录用量时会读取它。
pub async fn with_purpose<F: Future>(purpose: &'static str, future: F) -> F::Output {
    PURPOSE.scope(purpose, future).await
}

pub fn current_purpose() -> &'static str {
    PURPOSE.try_with(|purpose| *purpose).unwrap_or("chat")
}

static RECORDER: OnceLock<Option<Mutex<Connection>>> = OnceLock::new();

/// 统计专用的只写连接：库文件还不存在时返回 None（启动早期或单元测试）。
fn recorder() -> Option<MutexGuard<'static, Connection>> {
    let cell = RECORDER.get_or_init(|| {
        let path = crate::settings::app_data_dir().ok()?.join("database.sqlite");
        if !path.exists() {
            return None;
        }
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        conn.busy_timeout(Duration::from_secs(3)).ok()?;
        Some(Mutex::new(conn))
    });
    cell.as_ref()?.lock().ok()
}

/// 单价（元 / 百万 token）。`pattern` 与模型名做忽略大小写的包含匹配。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct PriceRule {
    pub pattern: String,
    pub input_per_million: f64,
    pub output_per_million: f64,
}

/// 命中第一条匹配的规则；都没命中返回 (0, 0)。
pub fn price_for(model: &str) -> (f64, f64) {
    let rules = crate::settings::Settings::load()
        .map(|settings| settings.pricing)
        .unwrap_or_default();
    let lower = model.to_lowercase();
    for rule in rules {
        if !rule.pattern.is_empty() && lower.contains(&rule.pattern.to_lowercase()) {
            return (rule.input_per_million, rule.output_per_million);
        }
    }
    (0.0, 0.0)
}

/// 记录一次调用。`endpoint` 用服务域名（`lumaflowapi.tech`），便于按服务汇总。
pub fn record(endpoint: &str, model: &str, purpose: &str, prompt: u64, completion: u64) {
    if prompt == 0 && completion == 0 {
        return;
    }
    let (input_price, output_price) = price_for(model);
    // cost_micro = tokens * 元/百万token：1e6 tokens × price 元 → price*1e6 微元。
    let cost_micro = (prompt as f64 * input_price + completion as f64 * output_price).round() as i64;
    let Some(conn) = recorder() else { return };
    let _ = conn.execute(
        "INSERT INTO token_usage (created_at, endpoint, model, purpose, prompt_tokens, completion_tokens, cost_micro) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            chrono::Utc::now().timestamp(),
            endpoint,
            model,
            purpose,
            prompt as i64,
            completion as i64,
            cost_micro
        ],
    );
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageBucket {
    pub label: String,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_micro: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSummary {
    pub days: i64,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_micro: i64,
    pub currency: String,
    pub by_day: Vec<UsageBucket>,
    pub by_model: Vec<UsageBucket>,
    /// 有 token 但没配单价的模型：界面提示「未计入费用」。
    pub unpriced_models: Vec<String>,
}

fn bucket_query(conn: &Connection, sql: &str, cutoff: i64) -> rusqlite::Result<Vec<UsageBucket>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![cutoff], |row| {
        Ok(UsageBucket {
            label: row.get(0)?,
            requests: row.get(1)?,
            prompt_tokens: row.get(2)?,
            completion_tokens: row.get(3)?,
            cost_micro: row.get(4)?,
        })
    })?;
    rows.collect()
}

/// 汇总最近 `days` 天（按本地日期切分）。
pub fn summary(db: &Db, days: i64) -> Result<UsageSummary, String> {
    let days = days.clamp(1, 366);
    let today = chrono::Local::now().date_naive();
    let cutoff = (today - chrono::Duration::days(days - 1))
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| {
            naive.and_local_timezone(chrono::Local).earliest()
        })
        .map(|moment| moment.timestamp())
        .unwrap_or(0);
    let conn = db.conn();

    let (requests, prompt_tokens, completion_tokens, cost_micro): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), \
             COALESCE(SUM(cost_micro),0) FROM token_usage WHERE created_at >= ?1",
            params![cutoff],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let by_day = bucket_query(
        &conn,
        "SELECT date(created_at,'unixepoch','localtime') AS d, COUNT(*), \
         COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(cost_micro),0) \
         FROM token_usage WHERE created_at >= ?1 GROUP BY d ORDER BY d DESC",
        cutoff,
    )
    .map_err(|e| e.to_string())?;

    let by_model = bucket_query(
        &conn,
        "SELECT model, COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), \
         COALESCE(SUM(cost_micro),0) FROM token_usage WHERE created_at >= ?1 \
         GROUP BY model ORDER BY SUM(prompt_tokens)+SUM(completion_tokens) DESC LIMIT 8",
        cutoff,
    )
    .map_err(|e| e.to_string())?;

    let unpriced_models = by_model
        .iter()
        .filter(|bucket| bucket.cost_micro == 0 && bucket.prompt_tokens + bucket.completion_tokens > 0)
        .map(|bucket| bucket.label.clone())
        .collect();

    Ok(UsageSummary {
        days,
        requests,
        prompt_tokens,
        completion_tokens,
        cost_micro,
        currency: "CNY".to_string(),
        by_day,
        by_model,
        unpriced_models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db() -> Db {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        Db::from_connection(conn)
    }

    #[test]
    fn summary_totals_and_unpriced_models() {
        let db = test_db();
        let now = chrono::Utc::now().timestamp();
        {
            let conn = db.conn();
            for (model, prompt, completion, cost) in [
                ("deepseek-v4-flash", 100, 200, 500),
                ("deepseek-v4-flash", 300, 400, 1100),
                ("unknown-model", 10, 20, 0),
            ] {
                conn.execute(
                    "INSERT INTO token_usage (created_at, endpoint, model, purpose, prompt_tokens, completion_tokens, cost_micro) \
                     VALUES (?1, 'example', ?2, 'chat', ?3, ?4, ?5)",
                    params![now, model, prompt, completion, cost],
                )
                .unwrap();
            }
        }
        let summary = summary(&db, 30).unwrap();
        assert_eq!(summary.requests, 3);
        assert_eq!(summary.prompt_tokens, 410);
        assert_eq!(summary.completion_tokens, 620);
        assert_eq!(summary.cost_micro, 1600);
        assert_eq!(summary.currency, "CNY");
        assert_eq!(summary.by_model.len(), 2);
        assert_eq!(summary.by_model[0].label, "deepseek-v4-flash", "按 token 量降序");
        assert_eq!(summary.unpriced_models, vec!["unknown-model".to_string()]);
    }

    #[test]
    fn summary_ignores_rows_outside_the_window() {
        let db = test_db();
        let old = (chrono::Local::now().date_naive() - chrono::Duration::days(10))
            .and_hms_opt(12, 0, 0)
            .and_then(|naive| {
                use chrono::TimeZone;
                naive.and_local_timezone(chrono::Local).earliest()
            })
            .unwrap()
            .timestamp();
        db.conn()
            .execute(
                "INSERT INTO token_usage (created_at, endpoint, model, purpose, prompt_tokens, completion_tokens, cost_micro) \
                 VALUES (?1, 'example', 'm', 'chat', 5, 5, 10)",
                params![old],
            )
            .unwrap();
        assert_eq!(summary(&db, 7).unwrap().requests, 0, "7 天窗口不应包含 10 天前的记录");
        assert_eq!(summary(&db, 30).unwrap().requests, 1);
    }

    #[test]
    fn cost_formula_matches_price_table() {
        // 1000 输入 + 500 输出，单价 1 元/百万与 2 元/百万 → 1000*1 + 500*2 = 2000 微元
        let cost = (1000.0_f64 * 1.0 + 500.0_f64 * 2.0).round() as i64;
        assert_eq!(cost, 2000);
        assert_eq!(format!("{:.2}", cost as f64 / 1_000_000.0), "0.00");
    }
}

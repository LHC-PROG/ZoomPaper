//! RAG：分块、向量入库、检索。
//!
//! 分块基于 MinerU 的 `content_list.json`（扁平 reading-order 语义块），
//! 按阅读顺序把正文块合并到约 `CHUNK_CHAR_LIMIT` 字符，标题处断开。
//! 向量写入 sqlite-vec 的 `vec_chunks`（rowid 对齐 `paper_chunks.id`）。

use crate::ai::embed;
use crate::db::models::SearchHit;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use zerocopy::AsBytes;

/// 合并后的单个 chunk 目标长度（字符）。
const CHUNK_CHAR_LIMIT: usize = 800;

/// 相邻 chunk 的重叠长度（字符）。
///
/// 句子正好被 800 字切断时，问题里的关键词可能落在下一块，
/// 留下约 15% 的重叠能让检索仍然命中这段上下文。
const CHUNK_OVERLAP_CHARS: usize = 120;

/// 章节路径最多保留的层级（`3.2 Attention > 3.2.1 Scaled …`）。
const SECTION_PATH_LEVELS: usize = 2;

/// 章节路径的最大长度，避免引用标签过长。
const SECTION_NAME_MAX: usize = 160;

/// 每轮检索该论文相关段落的条数。
pub const TOP_K: usize = 5;

/// 单个章节全文的长度上限（字符）。
pub const SECTION_MAX_CHARS: usize = 8000;

/// 章节级上下文总长度上限（字符）。
pub const SECTION_CTX_TOTAL_MAX: usize = 12000;

/// 章节地图 TOC 最多列出的章节数（其余省略）。
const TOC_MAX_SECTIONS: usize = 30;

/// content_list.json 中的单个块。
#[derive(Debug, Clone, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: Option<String>,
    pub text_level: Option<i32>,
    pub bbox: Option<Vec<f32>>,
    pub page_idx: Option<i32>,
}

/// 分块草稿（入库前）。
#[derive(Debug, Clone)]
pub struct ChunkDraft {
    pub section: String,
    pub content: String,
    pub start_block: i64,
    pub end_block: i64,
    pub page_idx: Option<i64>,
    pub bbox: Option<String>,
}

/// 章节标题里的编号（`3.2.1 Scaled …` → `3.2.1`），没有编号返回 None。
fn heading_number(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?.trim_end_matches('.');
    if token.is_empty() || !token.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    token
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.')
        .then(|| token.to_string())
}

/// 维护标题栈：子章节编号是父章节编号的前缀时压栈，否则回退到公共父级。
fn push_heading(path: &mut Vec<(String, String)>, text: &str) {
    match heading_number(text) {
        Some(number) => {
            while let Some((last, _)) = path.last() {
                let is_ancestor = !last.is_empty() && number.starts_with(&format!("{last}."));
                if is_ancestor {
                    break;
                }
                path.pop();
            }
            path.push((number, text.to_string()));
        }
        None => {
            path.clear();
            path.push((String::new(), text.to_string()));
        }
    }
}

/// 章节路径只保留最近两级：`3.2 Attention > 3.2.1 Scaled Dot-Product Attention`。
fn section_path(path: &[(String, String)]) -> String {
    let start = path.len().saturating_sub(SECTION_PATH_LEVELS);
    let joined = path[start..]
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join(" > ");
    joined.chars().take(SECTION_NAME_MAX).collect()
}

/// 取一段文字的尾部作为下一块的重叠前缀，尽量从词边界开始。
fn overlap_tail(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return String::new();
    }
    let slice: String = chars[chars.len() - limit..].iter().collect();
    match slice.find(char::is_whitespace) {
        Some(position) if position + 1 < slice.len() => slice[position + 1..].trim_start().to_string(),
        _ => slice,
    }
}

/// 按阅读顺序分块。标题（`text_level >= 1`）处断开并更新章节路径。
/// `text` 与 `equation` 块并入正文（MinerU 的 equation `text` 字段即 `$$...$$`
/// 包裹的 LaTeX 纯文本，文本 embedding 模型可直接消化）；`image`/`table` 等跳过。
///
/// 两个影响检索质量的行为：章节带层级路径（引用可读），相邻块留少量重叠（避免切断上下文）。
pub fn chunk_content_list(blocks: &[ContentBlock]) -> Vec<ChunkDraft> {
    let mut chunks = Vec::new();
    let mut path: Vec<(String, String)> = Vec::new();
    let mut buf = String::new();
    let mut start_block: i64 = 0;
    let mut start_page: Option<i64> = None;
    let mut start_bbox: Option<String> = None;
    // 上一块的尾部文字，等下一个正文块出现时才补进新块。
    // 若论文正好在分块边界结束，就不会多出一个只有重叠尾巴的碎块。
    let mut pending_overlap = String::new();
    // buf 里目前是上一块的重叠尾巴时，下一个正文块需要重新决定起始定位。
    let mut need_start = true;

    fn flush(
        chunks: &mut Vec<ChunkDraft>,
        path: &[(String, String)],
        buf: &mut String,
        start_block: i64,
        end_block: i64,
        start_page: Option<i64>,
        start_bbox: Option<String>,
    ) {
        if !buf.trim().is_empty() {
            chunks.push(ChunkDraft {
                section: section_path(path),
                content: buf.trim().to_string(),
                start_block,
                end_block,
                page_idx: start_page,
                bbox: start_bbox,
            });
        }
        buf.clear();
    }

    for (i, block) in blocks.iter().enumerate() {
        let idx = i as i64;
        let text = block.text.as_deref().unwrap_or("").trim();

        // 标题：断开当前 chunk，更新章节路径
        if block.text_level.unwrap_or(0) >= 1 && !text.is_empty() {
            flush(
                &mut chunks,
                &path,
                &mut buf,
                start_block,
                idx.saturating_sub(1),
                start_page,
                start_bbox.clone(),
            );
            push_heading(&mut path, text);
            pending_overlap.clear();
            start_block = idx;
            start_page = block.page_idx.map(i64::from);
            start_bbox = block
                .bbox
                .as_ref()
                .map(|b| serde_json::to_string(b).unwrap_or_default());
            need_start = true;
            continue;
        }

        // 只处理正文与公式块（公式以 $$...$$ LaTeX 形式并入，保证问答上下文包含公式）
        if text.is_empty() || (block.block_type != "text" && block.block_type != "equation") {
            continue;
        }

        // 重叠尾巴先落进新块，接着再写正文。
        if !pending_overlap.is_empty() {
            buf.push_str(&pending_overlap);
            pending_overlap.clear();
            need_start = true;
        }

        // 首个正文块记录起始定位（重叠尾巴不算正文起点）
        if need_start {
            start_block = idx;
            start_page = block.page_idx.map(i64::from);
            start_bbox = block
                .bbox
                .as_ref()
                .map(|b| serde_json::to_string(b).unwrap_or_default());
            need_start = false;
        }

        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(text);

        // 超长则 flush，并把尾部留给下一块
        if buf.chars().count() >= CHUNK_CHAR_LIMIT {
            pending_overlap = overlap_tail(&buf, CHUNK_OVERLAP_CHARS);
            flush(
                &mut chunks,
                &path,
                &mut buf,
                start_block,
                idx,
                start_page,
                start_bbox.clone(),
            );
        }
    }

    // 收尾
    flush(
        &mut chunks,
        &path,
        &mut buf,
        start_block,
        blocks.len() as i64 - 1,
        start_page,
        start_bbox,
    );

    chunks
}

/// 从论文目录找到旧版 content_list.json 路径（`_content_list.json` 结尾精确排除 v2）。
fn find_content_list(paper_dir: &Path) -> Result<std::path::PathBuf> {
    for entry in fs::read_dir(paper_dir).context("读取论文目录失败")? {
        let path = entry?.path();
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name == "content_list.json" || name.ends_with("_content_list.json") {
                return Ok(path);
            }
        }
    }
    anyhow::bail!("论文目录缺少 content_list.json")
}

#[cfg(test)]
#[test]
fn content_list_supports_plain_and_prefixed_mineru_names() {
    let dir = std::env::temp_dir().join(format!("zoompaper-content-list-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    for name in ["content_list.json", "paper_content_list.json"] {
        let file = dir.join(name);
        fs::write(&file, "[]").unwrap();
        assert_eq!(find_content_list(&dir).unwrap(), file);
        fs::remove_file(file).unwrap();
    }
    fs::remove_dir(dir).unwrap();
}

/// 只读 content_list.json 得到分块，不做向量化。
///
/// 本机提取正文后可以立即调用：章节树、章节全文、测验选题与关键词搜索
/// 都只依赖 `paper_chunks`，不依赖向量表。向量化失败不应让这些功能一起失效。
pub fn prepare_chunks(md_path: &str) -> Result<Vec<ChunkDraft>> {
    let paper_dir = Path::new(&md_path).parent().context("md_path 无父目录")?;
    let cl_path = find_content_list(paper_dir)?;
    let raw = fs::read_to_string(&cl_path).context("读取 content_list.json 失败")?;
    let blocks: Vec<ContentBlock> =
        serde_json::from_str(&raw).context("解析 content_list.json 失败")?;
    Ok(chunk_content_list(&blocks))
}

/// 索引一篇论文：分块 → embedding → 入库。返回 chunk 数量。
pub fn index_paper(conn: &Connection, paper_id: &str) -> Result<usize> {
    let md_path: String = conn
        .query_row(
            "SELECT md_path FROM papers WHERE id = ?1",
            [paper_id],
            |r| r.get(0),
        )
        .context("查询论文 md_path 失败")?;
    let (drafts, embeddings) = prepare_index(&md_path)?;
    insert_chunks(conn, paper_id, &drafts, &embeddings)?;
    Ok(drafts.len())
}

/// 只写正文分块（删除该论文旧分块与旧向量），不生成向量。
pub fn replace_chunks(conn: &Connection, paper_id: &str, drafts: &[ChunkDraft]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM paper_chunks WHERE paper_id = ?1)",
        [paper_id],
    )?;
    tx.execute("DELETE FROM paper_chunks WHERE paper_id = ?1", [paper_id])?;
    for draft in drafts {
        tx.execute(
            "INSERT INTO paper_chunks (paper_id, section, content, start_line, end_line, \
             page_idx, bbox) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                paper_id,
                draft.section,
                draft.content,
                draft.start_block,
                draft.end_block,
                draft.page_idx,
                draft.bbox,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 给已存在的分块按 id 顺序补写向量（先清掉该论文旧向量）。
pub fn attach_embeddings(
    conn: &Connection,
    paper_id: &str,
    embeddings: &[Vec<f32>],
) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt =
            conn.prepare("SELECT id FROM paper_chunks WHERE paper_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([paper_id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    anyhow::ensure!(
        ids.len() == embeddings.len(),
        "分块与向量数量不一致（{} vs {}）",
        ids.len(),
        embeddings.len()
    );
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM paper_chunks WHERE paper_id = ?1)",
        [paper_id],
    )?;
    for (id, embedding) in ids.iter().zip(embeddings) {
        tx.execute(
            "INSERT INTO vec_chunks (rowid, embedding, paper_id) VALUES (?1, ?2, ?3)",
            params![id, embedding.as_bytes(), paper_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// File IO and model inference must run without the shared database mutex.
pub fn prepare_index(md_path: &str) -> Result<(Vec<ChunkDraft>, Vec<Vec<f32>>)> {
    let drafts = prepare_chunks(md_path)?;
    if drafts.is_empty() {
        return Ok((vec![], vec![]));
    }

    // 分批 embedding
    let mut embeddings = Vec::with_capacity(drafts.len());
    for batch in drafts.chunks(32) {
        let texts: Vec<&str> = batch.iter().map(|d| d.content.as_str()).collect();
        embeddings.extend(embed::embed_texts(&texts).context("生成 embedding 失败")?);
    }

    Ok((drafts, embeddings))
}

/// 事务内写入 chunks 与向量（重索引幂等：先删旧数据）。
pub fn insert_chunks(
    conn: &Connection,
    paper_id: &str,
    drafts: &[ChunkDraft],
    embeddings: &[Vec<f32>],
) -> Result<()> {
    assert_eq!(
        drafts.len(),
        embeddings.len(),
        "chunks 与 embeddings 数量不一致"
    );

    replace_chunks(conn, paper_id, drafts)?;
    attach_embeddings(conn, paper_id, embeddings)?;
    Ok(())
}

/// 检索：向量化查询 → vec0 KNN → JOIN paper_chunks 拿内容。
///
/// `paper_id_filter` 为 `Some` 时只在该论文内检索。
pub fn search(
    conn: &Connection,
    query: &str,
    top_k: usize,
    paper_id_filter: Option<&str>,
) -> Result<Vec<SearchHit>> {
    let q = embed::embed_query(query).context("向量化查询失败")?;
    search_with_embedding(conn, &q, top_k, paper_id_filter)
}

/// 用已向量化的查询做检索（纯 DB 逻辑，便于测试）。
pub fn search_with_embedding(
    conn: &Connection,
    query_embedding: &[f32],
    top_k: usize,
    paper_id_filter: Option<&str>,
) -> Result<Vec<SearchHit>> {
    let q_bytes = query_embedding.as_bytes();

    // 第一步：vec0 KNN 拿 rowid + distance（k 用 format 拼，避免 vec0 参数化 k 兼容问题）
    let mut rowids: Vec<i64> = Vec::new();
    let mut distances: Vec<f32> = Vec::new();
    {
        if let Some(pid) = paper_id_filter {
            let sql = format!(
                "SELECT rowid, distance FROM vec_chunks \
                 WHERE embedding MATCH ?1 AND paper_id = ?2 AND k = {top_k}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![q_bytes, pid])?;
            while let Some(row) = rows.next()? {
                rowids.push(row.get(0)?);
                distances.push(row.get(1)?);
            }
        } else {
            let sql = format!(
                "SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ?1 AND k = {top_k}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![q_bytes])?;
            while let Some(row) = rows.next()? {
                rowids.push(row.get(0)?);
                distances.push(row.get(1)?);
            }
        }
    }

    // 第二步：JOIN papers 拿内容与标题
    let mut out = Vec::with_capacity(rowids.len());
    for (rowid, distance) in rowids.iter().zip(distances) {
        let chunk = match conn.query_row(
            "SELECT c.paper_id, p.title, c.section, c.content, c.page_idx \
             FROM paper_chunks c JOIN papers p ON p.id = c.paper_id \
             WHERE c.id = ?1 AND p.deleted_at IS NULL",
            [rowid],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            },
        ) {
            Ok(chunk) => chunk,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(error) => return Err(error.into()),
        };
        out.push(SearchHit {
            chunk_id: *rowid,
            paper_id: chunk.0,
            paper_title: chunk.1,
            section: chunk.2,
            content: chunk.3,
            page_idx: chunk.4,
            distance,
        });
    }

    Ok(out)
}

/// 某篇论文按阅读顺序去重后的非空章节列表（供章节地图 TOC，零 token 成本）。
pub fn sections_for_paper(conn: &Connection, paper_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT section FROM paper_chunks WHERE paper_id = ?1 AND section <> '' \
         GROUP BY section ORDER BY MIN(id)",
    )?;
    let rows = stmt.query_map([paper_id], |r| r.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// 组装章节地图：`【论文章节】\n- {name}`，节名截断 ≤60 字符、至多 `TOC_MAX_SECTIONS` 条。
pub fn build_toc(sections: &[String]) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from("【论文章节】\n");
    for s in sections.iter().take(TOC_MAX_SECTIONS) {
        let name: String = s.chars().take(60).collect();
        out.push_str(&format!("- {name}\n"));
    }
    if sections.len() > TOC_MAX_SECTIONS {
        out.push_str(&format!(
            "- ……（共 {} 节，仅列出前 {TOC_MAX_SECTIONS} 节）\n",
            sections.len()
        ));
    }
    out
}

/// 把检索命中的段落升级为「章节级全文」：按相关性（distance 升序）取前 `max_sections`
/// 个不同章节，拉取每个章节的完整文本（该 section 下所有 chunk 按 id 拼接）。
/// 单个章节按 `max_section_chars`、总量按 `max_total_chars` 封顶；返回 `(section, text)`。
pub fn expand_sections(
    conn: &Connection,
    paper_id: &str,
    hits: &[SearchHit],
    max_sections: usize,
    max_section_chars: usize,
    max_total_chars: usize,
) -> Result<Vec<(String, String)>> {
    let mut sorted: Vec<&SearchHit> = hits.iter().collect();
    sorted.sort_by(|a, b| {
        a.distance
            .partial_cmp(&b.distance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut total = 0usize;
    for hit in sorted {
        let section = hit.section.trim();
        if section.is_empty() || !seen.insert(section.to_string()) {
            continue;
        }
        if out.len() >= max_sections || total >= max_total_chars {
            break;
        }
        let mut text = String::new();
        let mut stmt = conn.prepare(
            "SELECT content FROM paper_chunks WHERE paper_id = ?1 AND section = ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![paper_id, section], |r| r.get::<_, String>(0))?;
        for part in rows {
            let part = part?;
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&part);
            if text.chars().count() >= max_section_chars {
                text = text.chars().take(max_section_chars).collect();
                break;
            }
        }
        if text.trim().is_empty() {
            continue;
        }
        total += text.chars().count();
        out.push((section.to_string(), text));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn block(block_type: &str, text: &str, level: i32, page: i32) -> ContentBlock {
        ContentBlock {
            block_type: block_type.to_string(),
            text: Some(text.to_string()),
            text_level: Some(level),
            bbox: Some(vec![0.0, 0.0, 100.0, 100.0]),
            page_idx: Some(page),
        }
    }

    #[test]
    fn build_toc_formats_and_caps_sections() {
        // 空 → 空字符串
        assert_eq!(build_toc(&[]), "");

        // 超长节名截断到 60 字符
        let long = "x".repeat(100);
        let toc = build_toc(&[long]);
        assert!(toc.starts_with("【论文章节】\n- "));
        assert!(toc.contains(&"x".repeat(60)));
        assert!(!toc.contains(&"x".repeat(61)));

        // 超过 TOC_MAX_SECTIONS → 省略提示
        let many: Vec<String> = (0..TOC_MAX_SECTIONS + 5)
            .map(|i| format!("Sec {i}"))
            .collect();
        let toc = build_toc(&many);
        assert_eq!(toc.matches("- Sec ").count(), TOC_MAX_SECTIONS);
        assert!(toc.contains("仅列出前"));
    }

    #[test]
    fn chunking_splits_on_title_and_merges_body() {
        let blocks = vec![
            block("title", "Introduction", 1, 0),
            block("text", "First sentence.", 0, 0),
            block("text", "Second sentence.", 0, 0),
            block("title", "Method", 1, 1),
            block("text", "Third sentence.", 0, 1),
            block("image", "", 0, 1), // 图片块应跳过
        ];
        let chunks = chunk_content_list(&blocks);

        assert_eq!(chunks.len(), 2);
        // 第一个 chunk：Introduction 下的两句话
        assert_eq!(chunks[0].section, "Introduction");
        assert!(chunks[0].content.contains("First sentence."));
        assert!(chunks[0].content.contains("Second sentence."));
        // 第二个 chunk：Method 下的正文
        assert_eq!(chunks[1].section, "Method");
        assert_eq!(chunks[1].content, "Third sentence.");
        assert_eq!(chunks[1].page_idx, Some(1));
    }

    #[test]
    fn chunking_includes_equation_blocks_in_reading_order() {
        let blocks = vec![
            block("text", "The reward is defined as", 0, 0),
            block(
                "equation",
                "$$\nR (\\tau) = \\sum_ {i} w _ {i} \\cdot R _ {i} (\\tau)\\tag{1}\n$$",
                0,
                0,
            ),
            block("text", "where w_i denotes the weight.", 0, 0),
        ];
        let chunks = chunk_content_list(&blocks);

        // 展示公式按阅读顺序并入前后文，AI 问答才能检索到公式
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].content,
            "The reward is defined as\n\
             $$\nR (\\tau) = \\sum_ {i} w _ {i} \\cdot R _ {i} (\\tau)\\tag{1}\n$$\n\
             where w_i denotes the weight."
        );
    }

    #[test]
    fn chunking_keeps_oversized_block_intact() {
        let long: String = "word ".repeat(300); // ~1500 字符，超过 800 阈值
        let blocks = vec![block("text", &long, 0, 0)];
        let chunks = chunk_content_list(&blocks);
        // 超长单块作为整体语义单元保持完整（bge 上限 512 tokens 足够容纳）
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, long.trim());
    }

    /// 章节路径要保留父子关系，引用里才能看出「这句话属于哪一节」。
    #[test]
    fn chunking_builds_nested_section_paths() {
        let blocks = vec![
            block("text", "3 Model Architecture", 1, 0),
            block("text", "Body under the model chapter.", 0, 0),
            block("text", "3.2 Attention", 1, 1),
            block("text", "Body under attention.", 0, 1),
            block("text", "3.2.1 Scaled Dot-Product Attention", 1, 1),
            block("text", "Body under the scaled variant.", 0, 1),
            block("text", "4 Training", 1, 2),
            block("text", "Body under training.", 0, 2),
        ];
        let chunks = chunk_content_list(&blocks);
        assert_eq!(chunks[0].section, "3 Model Architecture");
        assert_eq!(chunks[1].section, "3 Model Architecture > 3.2 Attention");
        assert_eq!(
            chunks[2].section,
            "3.2 Attention > 3.2.1 Scaled Dot-Product Attention"
        );
        assert_eq!(chunks[3].section, "4 Training");
    }

    /// 相邻块要有重叠，句子被切在 800 字边界时上下文才不会断。
    #[test]
    fn chunking_overlaps_neighbouring_chunks() {
        let long: String = "word ".repeat(300);
        let blocks = vec![
            block("text", "1 Introduction", 1, 0),
            block("text", &long, 0, 0),
            block("text", "Tail paragraph after the split.", 0, 1),
        ];
        let chunks = chunk_content_list(&blocks);
        assert_eq!(chunks.len(), 2);
        let first = &chunks[0].content;
        let tail: String = first.chars().skip(first.chars().count() - 60).collect();
        assert!(
            chunks[1].content.contains(tail.trim()),
            "第二块应以第一块尾部开头：{}",
            chunks[1].content
        );
        assert!(chunks[1].content.ends_with("Tail paragraph after the split."));
        // 重叠尾巴不单独成为碎块
        assert!(chunks.iter().all(|chunk| chunk.content.chars().count() > 60));
    }

    fn setup_db() -> Connection {
        db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::migrate(&conn).unwrap();
        // 插入论文记录以满足 paper_chunks.paper_id 外键
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path) VALUES ('paper-a', 'A', '/a.pdf', '/a.md')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers (id, title, pdf_path, md_path) VALUES ('paper-b', 'B', '/b.pdf', '/b.md')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn insert_and_search_align_rowid() {
        let conn = setup_db();

        // 两篇论文的 chunk，用 one-hot 向量区分
        let drafts = vec![
            ChunkDraft {
                section: "Intro".into(),
                content: "alpha chunk".into(),
                start_block: 0,
                end_block: 1,
                page_idx: Some(0),
                bbox: None,
            },
            ChunkDraft {
                section: "Method".into(),
                content: "beta chunk".into(),
                start_block: 2,
                end_block: 3,
                page_idx: Some(1),
                bbox: None,
            },
        ];
        let mut v0 = vec![0.0f32; 384];
        v0[0] = 1.0;
        let mut v1 = vec![0.0f32; 384];
        v1[1] = 1.0;
        let embeddings = vec![v0.clone(), v1.clone()];

        insert_chunks(&conn, "paper-a", &drafts, &embeddings).unwrap();

        // 跨论文检索，查询 = v0，应命中 alpha chunk（distance 0）
        let hits = search_with_embedding(&conn, &v0, 2, None).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "alpha chunk");
        assert_eq!(hits[0].paper_id, "paper-a");
        assert_eq!(hits[0].paper_title, "A");
        assert!(hits[0].distance < hits[1].distance);

        // paper_id 过滤：查不存在的论文，返回空
        let filtered = search_with_embedding(&conn, &v0, 2, Some("paper-b")).unwrap();
        assert!(filtered.is_empty());
    }

    /// 正文分块可以先入库、向量后补：本机解析在模型下载失败时仍要能看书、查章节。
    #[test]
    fn chunks_index_without_vectors_then_attach_later() {
        let conn = setup_db();
        let drafts = vec![ChunkDraft {
            section: "Intro".into(),
            content: "alpha chunk".into(),
            start_block: 0,
            end_block: 1,
            page_idx: Some(0),
            bbox: None,
        }];
        replace_chunks(&conn, "paper-a", &drafts).unwrap();

        // 没有向量时：章节树可用，语义检索查不到该论文（而不是报错）。
        assert_eq!(
            sections_for_paper(&conn, "paper-a").unwrap(),
            vec!["Intro".to_string()]
        );
        assert!(search_with_embedding(&conn, &vec![0.0f32; 384], 5, None)
            .unwrap()
            .is_empty());

        attach_embeddings(&conn, "paper-a", &[vec![0.0f32; 384]]).unwrap();
        let hits = search_with_embedding(&conn, &vec![0.0f32; 384], 5, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "alpha chunk");

        // 数量不一致必须报错，不能错位写入向量。
        assert!(attach_embeddings(&conn, "paper-a", &[]).is_err());
    }

    fn insert_chunks_with_sections(conn: &Connection, sections: &[(&str, &str)]) {        let drafts: Vec<ChunkDraft> = sections
            .iter()
            .map(|(s, c)| ChunkDraft {
                section: s.to_string(),
                content: c.to_string(),
                start_block: 0,
                end_block: 0,
                page_idx: Some(0),
                bbox: None,
            })
            .collect();
        let embeddings = vec![vec![0.0f32; 384]; drafts.len()];
        insert_chunks(conn, "paper-a", &drafts, &embeddings).unwrap();
    }

    fn hit_for(section: &str, content: &str, distance: f32) -> SearchHit {
        SearchHit {
            chunk_id: 1,
            paper_id: "paper-a".into(),
            paper_title: "A".into(),
            section: section.into(),
            content: content.into(),
            page_idx: Some(0),
            distance,
        }
    }

    #[test]
    fn sections_for_paper_returns_ordered_distinct_nonempty() {
        let conn = setup_db();
        insert_chunks_with_sections(
            &conn,
            &[
                ("Intro", "alpha"),
                ("Intro", "beta"),
                ("Method", "gamma"),
                ("", "no heading"), // 空 section 应跳过
                ("Intro", "delta"),
            ],
        );
        let sections = sections_for_paper(&conn, "paper-a").unwrap();
        assert_eq!(sections, vec!["Intro", "Method"]);
    }

    #[test]
    fn expand_sections_picks_top_sections_dedups_and_caps() {
        let conn = setup_db();
        insert_chunks_with_sections(
            &conn,
            &[
                ("Intro", "intro one"),
                ("Intro", "intro two"),
                ("Method", "method text"),
            ],
        );

        // 按 distance 排序：Method(0.1) 最先，Intro 两个命中去重为一个章节
        let hits = vec![
            hit_for("Intro", "intro one", 0.3),
            hit_for("Method", "method text", 0.1),
            hit_for("Intro", "intro two", 0.5),
        ];
        let out = expand_sections(&conn, "paper-a", &hits, 2, 1000, 2000).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, "Method");
        assert_eq!(out[0].1, "method text");
        assert_eq!(out[1].0, "Intro");
        assert_eq!(out[1].1, "intro one\nintro two");

        // max_sections=1 → 只取最相关章节
        let one = expand_sections(&conn, "paper-a", &hits, 1, 1000, 2000).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].0, "Method");
    }

    #[test]
    fn expand_sections_respects_char_cap() {
        let conn = setup_db();
        let content = "a".repeat(100);
        insert_chunks_with_sections(&conn, &[("Method", content.as_str())]);
        let hits = vec![hit_for("Method", "x", 0.1)];

        let out = expand_sections(&conn, "paper-a", &hits, 2, 10, 2000).unwrap();
        assert_eq!(out[0].1.chars().count(), 10);
    }

    /// 真实端到端：真实数据库 + 真实 content_list + 真实 embedding 模型。
    /// 需联网下载 bge 模型，且数据库里已有解析完成的论文，故默认跳过。
    #[test]
    #[ignore = "需要真实 embedding 模型下载与已解析论文"]
    fn real_index_paper_end_to_end() {
        let dir = crate::settings::app_data_dir().unwrap();
        let conn = crate::db::open(&dir.join("database.sqlite")).unwrap();

        let paper_id: String = conn
            .query_row(
                "SELECT id FROM papers WHERE parse_status = 'ready' ORDER BY created_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("数据库里应有至少一篇已解析论文");

        let n = index_paper(&conn, &paper_id).expect("真实索引失败");
        assert!(n > 0, "应产生至少一个 chunk");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM paper_chunks WHERE paper_id = ?1",
                [&paper_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, n as i64, "paper_chunks 行数应与 chunk 数一致");

        // 检索冒烟：模型已加载，直接查询应命中
        let hits = search(&conn, "transformer", 3, Some(&paper_id)).unwrap();
        assert!(!hits.is_empty(), "检索应命中 chunk");
    }
}

'use strict';

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// 终端里中日韩字符与全角符号占两列，按显示宽度对齐表格。
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

const MAX_CELL_WIDTH = 120;

// 文本模式下过长的单元格截断，完整内容用 --json 查看。
function truncate(text) {
  if (displayWidth(text) <= MAX_CELL_WIDTH) return text;
  let out = '';
  for (const ch of text) {
    if (displayWidth(out + ch) > MAX_CELL_WIDTH - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function renderTable(rows, headers) {
  if (!rows || rows.length === 0) return '(empty)';
  const columns = headers || Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const values = rows.map((row) => columns.map((column) => truncate(normalizeValue(row[column]))));
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column), ...values.map((line) => displayWidth(line[index])))
  );
  const pad = (cell, width) => `${cell}${' '.repeat(Math.max(0, width - displayWidth(cell)))}`;
  const join = (cells) => cells.map((cell, i) => pad(String(cell), widths[i])).join(' | ').trimEnd();
  const header = join(columns);
  const divider = widths.map((width) => '-'.repeat(width)).join('-+-');
  return `${header}\n${divider}\n${values.map(join).join('\n')}`;
}

function renderKv(data, headers = ['字段', '值']) {
  const [keyHeader, valueHeader] = headers;
  const rows = Object.entries(data || {}).map(([key, value]) => ({
    [keyHeader]: key,
    [valueHeader]: normalizeValue(value)
  }));
  return renderTable(rows, headers);
}

function createOutput({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (text) => stdout.write(`${text}\n`);
  return {
    json,
    stdout,
    stderr,
    jsonOut(payload) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
    text(text) {
      write(text);
    },
    table(rows, headers) {
      write(renderTable(rows, headers));
    },
    kv(data, headers) {
      write(renderKv(data, headers));
    },
    /**
     * 统一结果出口：JSON 模式输出完整对象；文本模式打印标题与表格/kv。
     */
    result(payload, { title, rows, headers, kv, tips } = {}) {
      if (json) {
        this.jsonOut(payload);
        return;
      }
      if (title) write(title);
      if (Array.isArray(rows)) {
        write(renderTable(rows, headers));
      } else if (kv && typeof kv === 'object') {
        write(renderKv(kv));
      }
      if (Array.isArray(tips) && tips.length > 0) {
        write('');
        for (const tip of tips) write(`- ${tip}`);
      }
    },
    errorLine(message) {
      stderr.write(`${message}\n`);
    }
  };
}

module.exports = { createOutput, renderTable, renderKv, normalizeValue };

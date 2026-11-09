'use strict';

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderTable(rows, headers) {
  if (!rows || rows.length === 0) return '(empty)';
  const columns = headers || Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const values = rows.map((row) => columns.map((column) => normalizeValue(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(String(column).length, ...values.map((line) => line[index].length))
  );
  const join = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i], ' ')).join(' | ');
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

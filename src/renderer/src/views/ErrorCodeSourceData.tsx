import { useMemo, useState } from 'react'
import { Check, Clipboard, Download, FileJson, Search } from 'lucide-react'
import {
  cloudErrorCodes,
  commonIssues,
  errorCodeData,
  errorCodeStats,
  hmsErrorCodes,
} from '../lib/dji-error-codes'

type SourceSection = 'cloud' | 'hms' | 'faq'

interface SourceRecord {
  key: string
  label: string
  description: string
  searchText: string
  value: unknown
}

const searchable = (value: unknown): string => JSON.stringify(value).toLocaleLowerCase()

const recordsBySection: Record<SourceSection, SourceRecord[]> = {
  cloud: cloudErrorCodes.map((entry) => ({
    key: `cloud:${entry.code}`,
    label: entry.code,
    description: entry.message ?? '未提供错误描述',
    searchText: searchable(entry),
    value: entry,
  })),
  hms: hmsErrorCodes.map((entry) => ({
    key: `hms:${entry.code}`,
    label: entry.code,
    description: entry.message ?? entry.faq ?? '未提供告警描述',
    searchText: searchable(entry),
    value: entry,
  })),
  faq: commonIssues.map((entry, index) => ({
    key: `faq:${index}`,
    label: `FAQ ${String(index + 1).padStart(3, '0')}`,
    description: entry.question,
    searchText: searchable(entry),
    value: entry,
  })),
}

const sectionMeta: Record<SourceSection, { label: string; count: number; fileName: string; dataKey: string }> = {
  cloud: {
    label: '上云错误码',
    count: errorCodeStats.cloud,
    fileName: 'dji-cloud-errors.json',
    dataKey: 'cloudErrors',
  },
  hms: {
    label: '机场 HMS',
    count: errorCodeStats.hms,
    fileName: 'dji-hms-errors.json',
    dataKey: 'hmsErrors',
  },
  faq: {
    label: '常见问题',
    count: errorCodeStats.faq,
    fileName: 'dji-common-issues.json',
    dataKey: 'commonIssues',
  },
}

const formattedJson = (value: unknown): string => JSON.stringify(value, null, 2)

export function ErrorCodeSourceData() {
  const [section, setSection] = useState<SourceSection>('cloud')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [copied, setCopied] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const records = useMemo(
    () => recordsBySection[section].filter((record) => !normalizedQuery || record.searchText.includes(normalizedQuery)),
    [normalizedQuery, section],
  )
  const selected = records.find((record) => record.key === selectedKey) ?? records[0]
  const selectedJson = selected ? formattedJson(selected.value) : ''

  const selectSection = (next: SourceSection): void => {
    setSection(next)
    setSelectedKey('')
    setCopied(false)
  }

  const copySelected = async (): Promise<void> => {
    if (!selectedJson) return
    await navigator.clipboard.writeText(selectedJson)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const downloadSection = (): void => {
    const meta = sectionMeta[section]
    const document = {
      schemaVersion: errorCodeData.schemaVersion,
      source: errorCodeData.source,
      [meta.dataKey]: recordsBySection[section].map((record) => record.value),
    }
    const url = URL.createObjectURL(new Blob([formattedJson(document)], { type: 'application/json' }))
    const link = window.document.createElement('a')
    link.href = url
    link.download = meta.fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="source-data-viewer">
      <header className="source-data-toolbar">
        <div className="segmented source-data-segmented" aria-label="源数据分类">
          {(Object.keys(sectionMeta) as SourceSection[]).map((key) => (
            <button className={section === key ? 'active' : ''} onClick={() => selectSection(key)} key={key}>
              {sectionMeta[key].label}<span>{sectionMeta[key].count}</span>
            </button>
          ))}
        </div>
        <label className="source-data-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索源数据字段或内容"
          />
        </label>
        <button className="button source-data-download" onClick={downloadSection} title="下载当前分类 JSON">
          <Download size={14} />下载 JSON
        </button>
      </header>

      <div className="source-data-layout">
        <section className="source-data-catalog">
          <header>
            <span>{records.length} 条记录</span>
            <code>{sectionMeta[section].dataKey}</code>
          </header>
          <div className="source-data-list" aria-label={`${sectionMeta[section].label}源数据列表`}>
            {records.map((record) => (
              <button
                className={`source-data-row ${selected?.key === record.key ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedKey(record.key)
                  setCopied(false)
                }}
                key={record.key}
              >
                <code>{record.label}</code>
                <span>{record.description}</span>
              </button>
            ))}
            {!records.length && (
              <div className="source-data-empty"><Search size={22} /><span>没有匹配的源数据</span></div>
            )}
          </div>
        </section>

        <article className="source-data-inspector">
          <header>
            <div>
              <span>原始 JSON</span>
              <strong>{selected?.label ?? '未选择记录'}</strong>
            </div>
            <button
              className="icon-button"
              onClick={() => void copySelected()}
              disabled={!selected}
              title={copied ? '已复制' : '复制 JSON'}
              aria-label={copied ? '已复制 JSON' : '复制 JSON'}
            >
              {copied ? <Check size={15} /> : <Clipboard size={15} />}
            </button>
          </header>
          {selected ? (
            <pre className="source-data-json"><code>{selectedJson}</code></pre>
          ) : (
            <div className="source-data-empty"><FileJson size={24} /><span>请调整搜索条件</span></div>
          )}
          <footer>
            <span>源文件：{errorCodeData.source.fileName}</span>
            <span>提取日期：{errorCodeData.source.extractedOn}</span>
            <span>Schema v{errorCodeData.schemaVersion}</span>
          </footer>
        </article>
      </div>
    </div>
  )
}

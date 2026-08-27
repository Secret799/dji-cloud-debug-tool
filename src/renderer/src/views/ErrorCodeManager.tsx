import { useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, CircleHelp, Search, Siren } from 'lucide-react'
import {
  cloudErrorCodes,
  commonIssues,
  errorCodeData,
  errorCodeStats,
  hmsDecimalCode,
  hmsErrorCodes,
} from '../lib/dji-error-codes'

type ErrorCodeSection = 'cloud' | 'hms' | 'faq'

interface DetailField {
  label: string
  value?: string | null
}

interface ErrorCodeRecord {
  key: string
  code: string
  title: string
  subtitle: string
  searchText: string
  fields: DetailField[]
}

const sectionMeta: Record<ErrorCodeSection, { label: string; count: number; icon: typeof CircleAlert }> = {
  cloud: { label: '上云错误码', count: errorCodeStats.cloud, icon: CircleAlert },
  hms: { label: '机场 HMS', count: errorCodeStats.hms, icon: Siren },
  faq: { label: '常见问题', count: errorCodeStats.faq, icon: CircleHelp },
}

const searchable = (values: Array<string | null | undefined>): string =>
  values.filter(Boolean).join(' ').toLocaleLowerCase()

const recordsBySection: Record<ErrorCodeSection, ErrorCodeRecord[]> = {
  cloud: cloudErrorCodes.map((entry) => ({
    key: `cloud:${entry.code}`,
    code: entry.code,
    title: entry.message ?? '未提供错误描述',
    subtitle: entry.source,
    searchText: searchable([
      entry.code,
      entry.source,
      entry.message,
      entry.logs,
      entry.cause,
      entry.solution,
    ]),
    fields: [
      { label: '错误来源', value: entry.source },
      { label: '显示信息', value: entry.message },
      { label: '可能原因', value: entry.cause },
      { label: '处理措施', value: entry.solution },
      { label: '定位日志', value: entry.logs },
    ],
  })),
  hms: hmsErrorCodes.map((entry) => {
    const decimal = hmsDecimalCode(entry.code)
    return {
      key: `hms:${entry.code}`,
      code: entry.code,
      title: entry.message ?? entry.faq ?? '未提供告警描述',
      subtitle: decimal ? `十进制 ${decimal}` : 'HMS 告警',
      searchText: searchable([
        entry.code,
        decimal,
        entry.message,
        entry.faq,
        entry.cause,
        entry.solution,
        ...entry.materials,
      ]),
      fields: [
        { label: '十进制错误码', value: decimal },
        { label: '告警文案', value: entry.message },
        { label: 'FAQ 建议', value: entry.faq },
        { label: '可能原因', value: entry.cause },
        { label: '处理措施', value: entry.solution },
        { label: '相关物料', value: entry.materials.join('\n') || null },
      ],
    }
  }),
  faq: commonIssues.map((entry, index) => ({
    key: `faq:${index}`,
    code: `FAQ ${String(index + 1).padStart(3, '0')}`,
    title: entry.question,
    subtitle: '上云常见问题',
    searchText: searchable([entry.question, entry.cause, entry.solution]),
    fields: [
      { label: '问题描述', value: entry.question },
      { label: '可能原因', value: entry.cause },
      { label: '处理方案', value: entry.solution },
    ],
  })),
}

const linkify = (value: string): ReactNode[] => value.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
  /^https?:\/\//.test(part)
    ? <a href={part} target="_blank" rel="noreferrer" key={`${part}:${index}`}>{part}</a>
    : part,
)

export function ErrorCodeManager() {
  const [section, setSection] = useState<ErrorCodeSection>('cloud')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const records = useMemo(
    () => recordsBySection[section].filter((entry) => !normalizedQuery || entry.searchText.includes(normalizedQuery)),
    [normalizedQuery, section],
  )
  const selected = records.find((entry) => entry.key === selectedKey) ?? records[0]

  const selectSection = (next: ErrorCodeSection): void => {
    setSection(next)
    setSelectedKey('')
  }

  return (
    <div className="error-code-manager">
      <header className="error-code-toolbar">
        <div className="segmented error-code-segmented" aria-label="错误码分类">
          {(Object.keys(sectionMeta) as ErrorCodeSection[]).map((key) => {
            const meta = sectionMeta[key]
            const Icon = meta.icon
            return (
              <button className={section === key ? 'active' : ''} onClick={() => selectSection(key)} key={key}>
                <Icon size={13} />{meta.label}<span>{meta.count}</span>
              </button>
            )
          })}
        </div>
        <label className="error-code-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索错误码、现象、原因或处理措施"
          />
        </label>
        <span className="error-code-result-count">{records.length} 条结果</span>
      </header>

      <div className="error-code-layout">
        <section className="error-code-list" aria-label={`${sectionMeta[section].label}列表`}>
          {records.map((entry) => (
            <button
              className={`error-code-row ${selected?.key === entry.key ? 'selected' : ''}`}
              onClick={() => setSelectedKey(entry.key)}
              key={entry.key}
            >
              <code>{entry.code}</code>
              <span><strong>{entry.title}</strong><small>{entry.subtitle}</small></span>
            </button>
          ))}
          {!records.length && (
            <div className="error-code-empty"><Search size={22} /><span>没有匹配的错误码或问题</span></div>
          )}
        </section>

        <article className="error-code-detail">
          {selected ? (
            <>
              <header>
                <div><code>{selected.code}</code><span>{selected.subtitle}</span></div>
                <h2>{selected.title}</h2>
              </header>
              <div className="error-code-detail-fields">
                {selected.fields.filter((field) => field.value).map((field) => (
                  <section className={field.label.includes('处理') || field.label.includes('排障') ? 'resolution' : ''} key={field.label}>
                    <h3>{field.label}</h3>
                    <p>{linkify(field.value ?? '')}</p>
                  </section>
                ))}
              </div>
              <footer>
                <span>数据来源：{errorCodeData.source.fileName}</span>
                <span>{errorCodeData.source.attribution}</span>
              </footer>
            </>
          ) : (
            <div className="error-code-empty"><CircleAlert size={24} /><span>请调整搜索条件</span></div>
          )}
        </article>
      </div>
    </div>
  )
}

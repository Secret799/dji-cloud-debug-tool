import { useEffect, useRef, useState } from 'react'
import { Cloud, Database, KeyRound, Plus, Save, Settings2, ShieldCheck, Trash2, X } from 'lucide-react'
import type { ObjectStorageProfile, ObjectStorageProvider, OperationResult } from '../../../shared/contracts'
import { createObjectStorageProfile, objectStorageProfileIssues } from '../lib/object-storage'
import { SecretInput } from '../components/SecretInput'
import { Tooltip } from '../components/Tooltip'

interface OssManagerProps {
  profiles: ObjectStorageProfile[]
  selectedId: string
  onSelect: (profileId: string) => void
  onSave: (profile: ObjectStorageProfile) => Promise<ObjectStorageProfile>
  onRemove: (profileId: string) => Promise<OperationResult>
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
}

const providerLabels: Record<ObjectStorageProvider, string> = {
  ali: '阿里云 OSS',
  aws: 'Amazon S3',
  minio: 'MinIO',
}

const providerDefaults: Record<ObjectStorageProvider, { region: string; endpoint: string }> = {
  ali: { region: 'cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com' },
  aws: { region: 'us-east-1', endpoint: 'https://s3.amazonaws.com' },
  minio: { region: '', endpoint: 'http://127.0.0.1:9000' },
}

const cloneProfile = (profile: ObjectStorageProfile): ObjectStorageProfile => ({ ...profile })

export function OssManager({ profiles, selectedId, onSelect, onSave, onRemove, onNotify }: OssManagerProps) {
  const selected = profiles.find((profile) => profile.id === selectedId)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<ObjectStorageProfile>(() => selected ? cloneProfile(selected) : createObjectStorageProfile())
  const [isNew, setIsNew] = useState(!selected)
  const [saving, setSaving] = useState(false)
  const resolveGeneration = useRef(0)

  const resolveProfile = async (profile: ObjectStorageProfile, generation: number): Promise<void> => {
    try {
      const resolved = await window.djiApi.objectStorage.resolve(profile.id)
      if (resolveGeneration.current !== generation || !resolved) return
      setDraft((current) => {
        if (current.id !== resolved.id) return current
        return {
          ...current,
          accessKeySecret: current.accessKeySecret || current.clearStoredAccessKeySecret
            ? current.accessKeySecret
            : resolved.accessKeySecret,
          securityToken: current.securityToken || current.clearStoredSecurityToken
            ? current.securityToken
            : resolved.securityToken,
          hasStoredAccessKeySecret: resolved.hasStoredAccessKeySecret,
          hasStoredSecurityToken: resolved.hasStoredSecurityToken,
        }
      })
    } catch (error) {
      if (resolveGeneration.current !== generation) return
      onNotify(`解密对象存储凭据失败：${error instanceof Error ? error.message : String(error)}，可重新输入后保存`, 'error')
    }
  }

  useEffect(() => {
    const current = profiles.find((profile) => profile.id === selectedId)
    if (!current) return
    const generation = resolveGeneration.current + 1
    resolveGeneration.current = generation
    setDraft(cloneProfile(current))
    setIsNew(false)
    void resolveProfile(current, generation)
  }, [profiles, selectedId])

  useEffect(() => () => { resolveGeneration.current += 1 }, [])

  const editProfile = (profile: ObjectStorageProfile): void => {
    const generation = resolveGeneration.current + 1
    resolveGeneration.current = generation
    onSelect(profile.id)
    setDraft(cloneProfile(profile))
    setIsNew(false)
    setEditorOpen(true)
    void resolveProfile(profile, generation)
  }

  const createProfile = (): void => {
    resolveGeneration.current += 1
    const next = createObjectStorageProfile()
    setDraft(next)
    setIsNew(true)
    setEditorOpen(true)
  }

  const closeEditor = (): void => {
    if (saving) return
    resolveGeneration.current += 1
    setEditorOpen(false)
  }

  const handleSave = async (): Promise<void> => {
    const issues = objectStorageProfileIssues(draft)
    if (issues.length) {
      onNotify(`请填写：${issues.join('、')}`, 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await onSave(draft)
      resolveGeneration.current += 1
      setDraft(cloneProfile(saved))
      setIsNew(false)
      onSelect(saved.id)
      setEditorOpen(false)
      onNotify('对象存储配置已保存', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (isNew || !profiles.some((profile) => profile.id === draft.id)) return
    if (!window.confirm(`确认删除对象存储“${draft.name}”？`)) return
    setSaving(true)
    try {
      const result = await onRemove(draft.id)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      onNotify('对象存储配置已删除', 'success')
      setEditorOpen(false)
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const issues = objectStorageProfileIssues(draft)

  return (
    <div className="oss-center">
      <aside className="oss-server-panel">
        <div className="oss-server-actions">
          <button className="button primary compact" type="button" onClick={createProfile}><Plus size={14} />添加 OSS 配置</button>
        </div>
        <div className="oss-server-list">
          {profiles.map((profile) => (
            <button key={profile.id} className={`oss-server-row ${selected?.id === profile.id ? 'selected' : ''}`} onClick={() => onSelect(profile.id)}>
              <span className={`oss-provider-icon ${profile.provider}`}><Database size={15} /></span>
              <span className="oss-server-copy"><strong>{profile.name}</strong><small>{profile.bucket || '未设置 Bucket'}</small></span>
              <i className={`oss-config-state-dot ${objectStorageProfileIssues(profile).length ? 'incomplete' : 'ready'}`} title={objectStorageProfileIssues(profile).length ? '配置未完成' : '可以使用'} />
            </button>
          ))}
        </div>
      </aside>
      {selected ? (
        <div className="oss-service-workspace">
          <section className="oss-service-config">
            <div className="oss-service-config-inner">
              <header className="oss-service-header">
                <div>
                  <span className={`oss-config-state-dot large ${objectStorageProfileIssues(selected).length ? 'incomplete' : 'ready'}`} />
                  <div><h2>{selected.name}</h2><span>{providerLabels[selected.provider]} · {objectStorageProfileIssues(selected).length ? '配置未完成' : '可以使用'}</span></div>
                </div>
                <button className="icon-button" type="button" title="编辑 OSS 配置" aria-label="编辑 OSS 配置" onClick={() => editProfile(selected)}><Settings2 size={16} /></button>
              </header>
              <dl className="oss-detail-list">
                <div><dt>Bucket</dt><dd>{selected.bucket || '未设置'}</dd></div>
                <div><dt>Region</dt><dd>{selected.region || '未设置'}</dd></div>
                <div className="wide"><dt>Endpoint</dt><dd>{selected.endpoint || '未设置'}</dd></div>
                <div><dt>Access Key ID</dt><dd>{selected.accessKeyId || '未设置'}</dd></div>
                <div><dt>Security Token</dt><dd>{selected.hasStoredSecurityToken ? '已加密保存' : '未设置'}</dd></div>
              </dl>
            </div>
          </section>
        </div>
      ) : (
        <div className="media-loading"><Database size={22} /><span>暂无 OSS 配置</span></div>
      )}
      {editorOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}>
          <form
            className="modal oss-config-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="oss-config-modal-title"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSave()
            }}
          >
            <header className="modal-header">
              <div><span className="eyebrow">OBJECT STORAGE</span><h2 id="oss-config-modal-title">{isNew ? '添加 OSS 配置' : '编辑 OSS 配置'}</h2></div>
              <Tooltip label="关闭"><button className="icon-button" type="button" disabled={saving} onClick={closeEditor}><X size={17} /></button></Tooltip>
            </header>
            <div className="modal-body settings-form oss-config-modal-body">
              <div className="oss-modal-summary">
                <span className="oss-section-icon"><Database size={18} /></span>
                <div><strong>{draft.name || '未命名配置'}</strong><span>{providerLabels[draft.provider]} · {draft.bucket || '未设置 Bucket'}</span></div>
                <span className={`oss-config-status ${issues.length ? 'incomplete' : 'ready'}`}>{issues.length ? '配置未完成' : '可以使用'}</span>
              </div>
              <section className="oss-form-group">
                <div className="oss-form-group-title"><Cloud size={15} /><span>存储服务</span></div>
                <div className="field-grid two-columns">
                  <label className="field"><span>配置名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label className="field"><span>云存储厂商</span><select value={draft.provider} onChange={(event) => {
                    const provider = event.target.value as ObjectStorageProvider
                    setDraft((current) => ({ ...current, provider, ...providerDefaults[provider] }))
                  }}>{Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="field"><span>Bucket</span><input value={draft.bucket} onChange={(event) => setDraft((current) => ({ ...current, bucket: event.target.value }))} /></label>
                  <label className="field"><span>Region</span><input value={draft.region} onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))} placeholder={draft.provider === 'minio' ? '可留空' : 'cn-hangzhou'} /></label>
                  <label className="field oss-endpoint-field"><span>Endpoint</span><input value={draft.endpoint} onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://..." /></label>
                </div>
              </section>
              <section className="oss-form-group">
                <div className="oss-form-group-title"><KeyRound size={15} /><span>访问凭证</span></div>
                <div className="field-grid two-columns">
                  <label className="field"><span>Access Key ID</span><input value={draft.accessKeyId} onChange={(event) => setDraft((current) => ({ ...current, accessKeyId: event.target.value }))} /></label>
                  <SecretInput
                    key={`${draft.id}:access-key-secret`}
                    label="Access Key Secret"
                    value={draft.accessKeySecret}
                    onChange={(accessKeySecret) => setDraft((current) => ({
                      ...current,
                      accessKeySecret,
                      clearStoredAccessKeySecret: accessKeySecret ? false : Boolean(current.hasStoredAccessKeySecret),
                    }))}
                    placeholder={draft.clearStoredAccessKeySecret ? '请输入新密钥' : draft.hasStoredAccessKeySecret ? '已加密保存' : '必填'}
                  />
                  <SecretInput
                    key={`${draft.id}:security-token`}
                    label="Security Token"
                    value={draft.securityToken}
                    onChange={(securityToken) => setDraft((current) => ({
                      ...current,
                      securityToken,
                      clearStoredSecurityToken: securityToken ? false : Boolean(current.hasStoredSecurityToken),
                    }))}
                    placeholder={draft.clearStoredSecurityToken ? '保存后清除' : draft.hasStoredSecurityToken ? '已加密保存' : '可选'}
                  />
                </div>
              </section>
              <div className="oss-modal-security"><ShieldCheck size={14} /><span>密钥由应用内 AES-256-GCM 加密保存</span></div>
            </div>
            <footer className="modal-footer">
              {!isNew && <button className="button danger-ghost" type="button" disabled={saving} onClick={() => void handleRemove()}><Trash2 size={14} />删除</button>}
              {isNew && <span />}
              <div className="footer-actions">
                <button className="button secondary" type="button" disabled={saving} onClick={closeEditor}>取消</button>
                <button className="button primary" type="submit" disabled={saving}><Save size={14} />{saving ? '保存中' : '保存配置'}</button>
              </div>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}

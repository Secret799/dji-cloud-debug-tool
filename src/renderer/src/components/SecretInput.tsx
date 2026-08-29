import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface SecretInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoComplete?: string
  disabled?: boolean
}

export function SecretInput({
  label,
  value,
  onChange,
  placeholder,
  autoComplete = 'new-password',
  disabled = false,
}: SecretInputProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const previousValueRef = useRef(value)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!previousValueRef.current && value && document.activeElement !== inputRef.current) setVisible(false)
    previousValueRef.current = value
  }, [value])

  return (
    <div className="field">
      <span id={`${inputId}-label`}>{label}</span>
      <div className="secret-input">
        <input
          ref={inputRef}
          id={inputId}
          aria-labelledby={`${inputId}-label`}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
        />
        <Tooltip label={visible ? `隐藏${label}` : `显示${label}`}>
          <button
            type="button"
            className="icon-button"
            disabled={disabled}
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

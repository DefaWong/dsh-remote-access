/**
 * The members of the DSH client module table this page uses. The page's
 * module loader supplies the running application's copies at runtime; these
 * declarations only describe the subset the page calls.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactNode } from 'react'

  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }
  export interface SettingsFieldState { text: string; overridden: boolean; invalid: boolean }
  export interface SettingsFormActions {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  }
  export interface SettingsFieldSpec { readonly field: string }
  export interface SettingsFormScope { getSnapshot(): { value: unknown }; subscribe(listener: () => void): () => void }
  export interface SnapshotStore<S> { getSnapshot(): S; subscribe(listener: () => void): () => void }

  export class SettingsFormModel {
    constructor(scope: SettingsFormScope, specs: SettingsFieldSpec[])
    bind<S>(project: () => S): SnapshotStore<S>
    shell(): SettingsFormShell
    field(field: string): SettingsFieldState
    actions(): SettingsFormActions
    dispose(): void
  }
  export function settingsTextField(field: string): SettingsFieldSpec
  export function settingsNumberField(field: string): SettingsFieldSpec

  export function SettingsForm(props: {
    labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string }
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children: ReactNode
  }): ReactNode
  export function SettingsValueField(props: {
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    numeric?: boolean
    placeholder?: string
    onEdit: (text: string) => void
    onReset: () => void
  }): ReactNode
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
}

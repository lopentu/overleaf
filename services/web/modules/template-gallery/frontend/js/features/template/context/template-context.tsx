import {
  createContext,
  Dispatch,
  SetStateAction,
  ReactNode,
  useContext,
  useState,
  useMemo,
} from 'react'
import getMeta from '@/utils/meta'
import { Template } from '../../../../../types/template'

type TemplateContextType = {
  template: Template
  setTemplate: Dispatch<SetStateAction<Template>>
}

export const TemplateContext = createContext<TemplateContextType | undefined>(
  undefined
)

type TemplateProviderProps = {
  children: ReactNode
}

export const TemplateProvider = ({ children }: TemplateProviderProps) => {
  const loadedTemplate = useMemo(() => getMeta('ol-template'), [])
  const [template, setTemplate] = useState(loadedTemplate)

  const value = useMemo(
    () => ({
      template,
      setTemplate,
    }),
    [template, setTemplate]
  )

  return (
    <TemplateContext.Provider value={value}>
      {children}
    </TemplateContext.Provider>
  )
}

export const useTemplateContext = () => {
  const context = useContext(TemplateContext)
  if (!context) {
    throw new Error(`useTemplateContext must be used within a TemplateProvider`)
  }
  return context
}

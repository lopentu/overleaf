import type { PaymentProviderAddOn } from './plan'

/** Public fields consumed by CustomerIoPlanHelpers, independent of billing plugins. */
export type PaymentPlanTelemetry = {
  subscription?: {
    state?: string | null
    periodEnd?: Date | string | number | null
    planCode?: string | null
    addOns?: Pick<PaymentProviderAddOn, 'code'>[] | null
  } | null
}

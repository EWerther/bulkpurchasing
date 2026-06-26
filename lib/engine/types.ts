export type Company = 'FTX' | 'SBYL'

export interface DemandItem {
  id: string
  itemId: number
  sku: string
  productName: string
  company: Company
  orderedQty: number
  eta: Date
  sourceType: 'PO' | 'CustomerOrder'
  sourceRef: string
  isNewProduct: boolean
  ads: number
  currentInventory: number
  currentDOC: number
  priorityScore: number
}

export interface RecipeLine {
  supplyItemId: number
  supplySKU: string
  supplyName: string
  supplyCategory: string
  qtyPerUnit: number
}

export interface SupplyPOArrival {
  poId: number
  poNumber: string
  eta: Date           // effective ETA — normalized to today if real ETA is in the past
  originalEta?: Date  // real ERP ETA (only populated when overdue)
  isOverdue?: boolean // true when real ETA has passed but PO not yet received
  qty: number
}

export interface SupplyItem {
  itemId: number
  sku: string
  name: string
  category: string
  onHandQty: number
  futurePOs: SupplyPOArrival[]
  vendorLeadTimeDays: number
  substituteItemId?: number
  substituteSKU?: string
}

export interface IngredientDetail {
  supplyItemId: number
  supplySKU: string
  supplyName: string
  supplyCategory: string
  qtyPerUnit: number
  qtyNeeded: number
  qtyAvailable: number
  shortage: number
  canOrderInTime: boolean
  leadTimeDays: number
  daysUntilETA: number
  isSubstituted: boolean
  substituteSKU?: string
  substituteQtyUsed: number
  substituteStillShort: number
}

export interface FeasibilityResult {
  status: 'Full' | 'Partial' | 'None' | 'NoRecipe'
  canProduceQty: number
  requiresNewSupplyPO: boolean
  usesSubstitute: boolean
  ingredientDetails: IngredientDetail[]
}

export interface AllocationWarning {
  type: 'SupplyStranded' | 'CrossProductConflict' | 'NewProductConflict'
  message: string
  affectedDemandIds: string[]
  supplyItemId: number
  supplySKU: string
  qtyAtRisk: number
  recommendedAction: string
}

export interface AllocationResult {
  demandId: string
  allocations: Map<number, number>
  feasibilityStatus: 'Full' | 'Partial' | 'None'
  warnings: AllocationWarning[]
}

export interface GeneratedPOLine {
  sku: string
  itemId: number
  productName: string
  company: Company
  arrivalDate: Date
  orderedQty: number
  projectedInventoryAtTrigger: number
  projectedDOCAtTrigger: number
  ads: number
  currentInventory: number
  isNewProduct: boolean
  feasibilityStatus?: 'Full' | 'Partial' | 'None' | 'NoRecipe'
  feasibleDate?: Date
  ingredientDetails?: IngredientDetail[]
}

export type POReviewStatus = 'Locked' | 'Rush' | 'Push Off' | 'On Track'

export interface POReviewLine {
  poId: number
  poItemId: number
  poNumber: string
  sku: string
  itemId: number
  productName: string
  company: Company
  currentETA: Date
  effectiveETA: Date
  orderedQty: number
  ads: number
  currentInventory: number
  currentDOC: number
  projectedDOC: number
  docAfterArrival: number
  status: POReviewStatus
  suggestedETA?: Date
  isNewProduct: boolean
  minDOC: number
  maxDOC: number
}

export type POActionType = 'Create' | 'UpdateETA' | 'UpdateQty' | 'UpdateBoth' | 'ConsiderCancel' | 'PushETA'

export interface POAction {
  actionType: POActionType
  sku: string
  itemId: number
  productName: string
  company: Company
  poId?: number
  poItemId?: number
  poNumber?: string
  currentETA?: Date
  recommendedETA?: Date
  currentQty?: number
  recommendedQty?: number
  reason: string
  currentInventory: number
  currentDOC: number
  ads: number
  isNewProduct: boolean
  feasibilityStatus?: string
  optimizerWarning?: AllocationWarning
}

export interface NotFeasibleItem {
  sku: string
  itemId: number
  productName: string
  company: Company
  scheduledQty: number
  orderedQty: number
  arrivalDate: Date
  ingredientDetails: IngredientDetail[]
  shortageGroupKey: string
}

export interface NewProductItem {
  sku: string
  itemId: number
  productName: string
  company: Company
  openPOLines: ERPPOLine[]
}

export interface ERPPOLine {
  poId: number
  poItemId: number
  poNumber: string
  eta: Date
  qty: number
  isNewProduct: boolean
  itemId: number
  sku: string
  productName: string
  category: string
}

export interface ScheduledDay {
  date: Date
  items: ScheduledItem[]
  totalQty: number
  isOverCapacity: boolean
  hasConflict: boolean
  conflicts: SupplyConflict[]
}

export interface ScheduledItem {
  demandId: string
  poId: number
  poItemId: number
  poNumber: string
  sku: string
  itemId: number
  productName: string
  company: Company
  scheduledQty: number
  orderedQty: number
  scheduledDate: Date
  originalETA: Date
  isLocked: boolean
  isInfeasibleLocked: boolean
  isNewProduct: boolean
  docAtDate: number
  moveReason?: string
  feasibilityStatus: 'Full' | 'Partial' | 'None' | 'NoRecipe'
  ingredientDetails: IngredientDetail[]
  optimizerWarnings: AllocationWarning[]
}

export interface SupplyConflict {
  supplyItemId: number
  supplySKU: string
  supplyName: string
  totalAvailable: number
  competing: ConflictingDemand[]
}

export interface ConflictingDemand {
  demandId: string
  sku: string
  productName: string
  company: Company
  sourceRef: string
  priorityScore: number
  isNewProduct: boolean
  requestedQty: number
  allocatedQty: number
  qtyPerUnit: number
}

export interface InventoryRecord {
  itemId: number
  sku: string
  totalUnits: number
}

export interface ADSRecord {
  itemId: number
  sku: string
  ads: number
}

export interface TFMItemMap {
  ftxSKU: string
  tfmItemId: number
  tfmSKU: string
}

export interface CustomerOrder {
  orderId: number
  orderNumber: string
  company: string
  sku: string
  itemId: number
  productName: string
  category: string
  readyByDate: Date
  orderedQty: number
  status: string
  isCompleted: boolean
  isReceived: boolean
}

export interface ProductionBoardItem {
  orderId: number
  orderNumber: string
  company: string
  sku: string
  productName: string
  qty: number
  readyByDate: Date
  status: 'Received' | 'Completed' | 'Open'
}

export interface ProductionBoardDay {
  date: Date
  items: ProductionBoardItem[]
  totalQty: number
  isOverCapacity: boolean
}

export interface SupplyConsumptionEvent {
  orderNumber: string
  date: string        // ISO YYYY-MM-DD
  qty: number
  productSku: string
  productName: string
}

export interface SupplyComponentView {
  itemId: number
  sku: string
  name: string
  category: string
  onHandQty: number
  committedQty: number
  availableQty: number
  futurePOs: SupplyPOArrival[]
  consumptionEvents: SupplyConsumptionEvent[]
  allocations: SupplyAllocationView[]
  projectedTimeline: ProjectedStockDay[]
  hasShortageRisk: boolean
  warnings: AllocationWarning[]
}

export interface SupplyAllocationView {
  company: Company
  type: 'PO' | 'CustomerOrder'
  reference: string
  sku: string
  productName: string
  dueDate: Date
  qtyAllocated: number
  feasibilityStatus: 'Full' | 'Partial' | 'None'
  priorityScore: number
  isNewProduct: boolean
  sourcePage: 'po-schedule' | 'production-schedule' | 'order-feasibility'
}

export interface ProjectedStockDay {
  date: Date
  stock: number
  arrivals: number
  consumed: number
}

// ── Factory floor tracking ─────────────────────────────────────────────────

export interface OpenProductionOrderLine {
  whoiId: number        // WP_WHOI primary key — unique line identifier
  whodId: number        // WP_WHOD header ID
  orderNumber: string
  company: string
  sku: string
  itemId: number
  productName: string
  category: string
  readyByDate: Date
  orderedQty: number
  lineStatus: 'Open' | 'Received'
}

export interface FactorySession {
  id: number
  sessionDate: string   // ISO date string YYYY-MM-DD
  lineNumber: number    // 1 or 2
  shiftNumber: number   // 1 or 2
  whoiId: number
  whodId: number
  orderNumber: string
  sku: string
  productName: string
  targetQty: number
  producedQty: number
  status: 'pending' | 'active' | 'complete'
  createdAt: string
  updatedAt: string
}

export interface FactoryProductionLog {
  id: number
  sessionId: number
  qtyAdded: number
  operatorName: string | null
  note: string | null
  recordedAt: string
}

export interface FactorySessionWithLogs extends FactorySession {
  logs: FactoryProductionLog[]
}

/**
 * RPKG (repackage) mapping: a component item (ordered from TFM) that gets
 * assembled into a master item (what is actually sold / has ADS).
 *
 * Only populated for SBYL — FTX has no RPKG records.
 *
 * Demand logic:
 *   - ADS  → use masterItemId's ADS
 *   - PO   → place against componentItemId / componentSku
 *   - Inventory → masterInventory + componentInventory (both count as "available")
 */
export interface RpkgMapping {
  componentItemId: number
  componentSku: string
  componentName: string
  masterItemId: number
  masterSku: string
  quantity: number  // units of component per master unit (always 1 in practice)
}

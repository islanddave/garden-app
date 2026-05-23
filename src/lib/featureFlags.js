// Feature flags for gated UI surfaces.
// V1.2a-4 S1 (PROJ-RESCOPE): cultivar option in ProjectNew kind dropdown is gated
// until VARIETY-REF S4 lands the Cultivar-as-first-class flow. See V102 §5.2.
export const VARIETY_REF_UI_SHIPPED = false // Flips true when VARIETY-REF S4 ships per V102 §5.2

// 2.0.1 (gifted-busy-thompson): the Catch-up badge in the More menu linked to
// /plants/catch-up, whose S1.1 editor was never built — it shipped into V2 as a
// "coming soon" dead-end. Badge is hidden until the editor ships. Flip true when the
// S1.1 catch-up editor lands (planned 2.1). See v2-increment-audit-2.0.1-to-2.1-V001.
export const CATCH_UP_EDITOR_SHIPPED = false

// V4-CROPTYPERETIRE-001 — what a person sees when the name typed into an inline "new crop type" form
// matches a type the admin retired. The server answers 403 with this code (RETIRED_CODE in
// lambda/varieties/crop-type-admin.js); useCropTypes turns it into this one line, so VarietyPicker and
// the variety editor's crop-type field both print the same words.
export const CROP_TYPE_RETIRED_CODE = 'crop_type_retired'
export const CROP_TYPE_RETIRED_LINE = "That crop type was retired. Ask the garden's admin to bring it back."

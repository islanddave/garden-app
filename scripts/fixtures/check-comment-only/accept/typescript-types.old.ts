// the shape
export interface Plant {
  id: string // primary key
  name?: string
}
export const cast = <T,>(x: unknown) => x as T // narrow

export interface Plant {
  id: string
  name?: string
}
export const cast = <T,>(x: unknown) => x as T

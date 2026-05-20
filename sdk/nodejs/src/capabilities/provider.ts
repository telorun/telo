export interface Provider<TOutput = unknown> {
  provide(): Promise<TOutput>;
}

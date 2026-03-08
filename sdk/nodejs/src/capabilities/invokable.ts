export interface Invokable {
  invoke(inputs: Record<string, any>): Promise<any>;
}

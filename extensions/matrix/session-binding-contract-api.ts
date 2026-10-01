// Matrix API module exposes the plugin public contract.
export {
  createMatrixThreadBindingManager,
  type MatrixThreadBindingManagerParams,
  type MatrixThreadBindingManagerParamsV2,
} from "./src/matrix/thread-bindings.js";
export { setMatrixRuntime } from "./src/runtime.js";

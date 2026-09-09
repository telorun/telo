import {
  ApisApi,
  Attach,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  Watch,
} from "@kubernetes/client-node";

export interface KubeClient {
  kc: KubeConfig;
  core: CoreV1Api;
  networking: NetworkingV1Api;
  /** Gateway API has no typed client in `@kubernetes/client-node`, so HTTPRoutes
   *  are read and written as unstructured custom objects. */
  custom: CustomObjectsApi;
  /** API-group discovery, used to decide whether Gateway API is served at all
   *  when the routing mode is `auto`. */
  apis: ApisApi;
  attach: Attach;
  watch: Watch;
}

/**
 * Loads kube config — in-cluster (projected ServiceAccount token + CA) when
 * running as a Pod, falling back to the local kubeconfig for out-of-cluster
 * development.
 */
export function createKubeClient(): KubeClient {
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return {
    kc,
    core: kc.makeApiClient(CoreV1Api),
    networking: kc.makeApiClient(NetworkingV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    apis: kc.makeApiClient(ApisApi),
    attach: new Attach(kc),
    watch: new Watch(kc),
  };
}

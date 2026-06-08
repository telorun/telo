import {
  Attach,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  Watch,
} from "@kubernetes/client-node";

export interface KubeClient {
  kc: KubeConfig;
  core: CoreV1Api;
  batch: BatchV1Api;
  networking: NetworkingV1Api;
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
    batch: kc.makeApiClient(BatchV1Api),
    networking: kc.makeApiClient(NetworkingV1Api),
    attach: new Attach(kc),
    watch: new Watch(kc),
  };
}

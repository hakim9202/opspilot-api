export class RegisterAgentDto {
  installToken!: string;
  hostname!: string;
  environment!: string;
  clusterName!: string;
  version!: string;
  labels?: Record<string, string>;
}

export class PodInventoryItemDto {
  namespace!: string;
  name!: string;
  status!: string;
  ready?: string;
  restarts!: number;
  age!: string;
  cpu?: string;
  memory?: string;
}

export class HeartbeatDto {
  status!: string;
  version!: string;
  meta?: Record<string, string>;
  pods?: PodInventoryItemDto[];
}

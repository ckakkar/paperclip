/** The parts of the SmartThings device API Paperclip reads. */

export interface DeviceCapabilityRef {
  id: string;
  version?: number;
}

export interface DeviceComponent {
  id: string;
  label?: string;
  capabilities: DeviceCapabilityRef[];
  categories?: { name: string; categoryType?: string }[];
}

export interface Device {
  deviceId: string;
  name?: string;
  label?: string;
  manufacturerName?: string;
  presentationId?: string;
  deviceManufacturerCode?: string;
  locationId?: string;
  roomId?: string;
  type?: string;
  components: DeviceComponent[];
  ocf?: {
    ocfDeviceType?: string;
    name?: string;
    manufacturerName?: string;
    modelNumber?: string;
    firmwareVersion?: string;
    vendorId?: string;
  };
}

export interface AttributeState {
  value: unknown;
  unit?: string;
  timestamp?: string;
}

/** capability id → attribute name → state */
export type ComponentStatus = Record<string, Record<string, AttributeState | undefined> | undefined>;

export interface DeviceStatus {
  components?: Record<string, ComponentStatus | undefined>;
}

export interface DeviceHealth {
  deviceId?: string;
  state?: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | string;
  lastUpdatedDate?: string;
}

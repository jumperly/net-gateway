// The GATT tables of Bluetooth LE devices, shared by the simulator protocol and the gateway protocol.

/** A characteristic of a device around the user, as the page sees it (Web Bluetooth). */
export interface GattCharacteristicDesc {
  /** Lower case, the full 128-bit form. */
  uuid: string;
  /** The page's handle of it in `gattOp`. */
  ref: number;
  /** GATT properties (`BLE_PROP` bits: 0x02 read, 0x04 write without response, 0x08 write, 0x10 notify, 0x20 indicate). */
  properties: number;
  descriptors: Array<{ uuid: string; ref: number }>;
}
export interface GattServiceDesc {
  uuid: string;
  characteristics: GattCharacteristicDesc[];
}

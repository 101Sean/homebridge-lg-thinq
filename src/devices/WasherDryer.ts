import { AccessoryContext, BaseDevice } from '../baseDevice.js';
import { LGThinQHomebridgePlatform } from '../platform.js';
import { CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';
import { Device } from '../lib/Device.js';
import { PlatformType } from '../lib/constants.js';
import { DeviceModel } from '../lib/DeviceModel.js';

export const NOT_RUNNING_STATUS = ['COOLDOWN', 'POWEROFF', 'POWERFAIL', 'INITIAL', 'PAUSE', 'AUDIBLE_DIAGNOSIS', 'FIRMWARE',
  'COURSE_DOWNLOAD', 'ERROR', 'END'];

export default class WasherDryer extends BaseDevice {
  public isRunning = false;
  public isServiceTubCleanMaintenanceTriggered = false;

  protected serviceWasherDryer: Service | undefined;
  protected servicePowerOff: Service | undefined;
  protected serviceEventFinished: Service | undefined;
  protected serviceDoorLock: Service | undefined;
  protected serviceTubCleanMaintenance: Service | undefined;

  constructor(
      public readonly platform: LGThinQHomebridgePlatform,
      public readonly accessory: PlatformAccessory<AccessoryContext>,
      logger: Logger,
  ) {
    super(platform, accessory, logger);

    const {
      Service: {
        OccupancySensor,
        ContactSensor,
        StatelessProgrammableSwitch,
        LockMechanism,
        Valve,
      },
      Characteristic,
      Characteristic: {
        LockCurrentState,
      },
    } = this.platform;

    const device: Device = accessory.context.device;

    // Faucet
    this.serviceWasherDryer = accessory.getService(Valve) || accessory.addService(Valve, device.name, device.name);
    this.serviceWasherDryer.getCharacteristic(Characteristic.Active)
        .onSet(this.setActive.bind(this));

    this.serviceWasherDryer.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.WATER_FAUCET);
    this.serviceWasherDryer.getCharacteristic(Characteristic.RemainingDuration).setProps({ maxValue: 86400 });

    // Power off
    const powerOffName = `${device.name} Power Off`;
    this.servicePowerOff = accessory.getService(powerOffName) || accessory.getService(StatelessProgrammableSwitch);
    if (!this.servicePowerOff) {
      this.servicePowerOff = accessory.addService(StatelessProgrammableSwitch, powerOffName, 'power-off-button');
    }
    this.servicePowerOff.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .onSet(async () => {
          this.logger.info(`[${device.name}] 전원 끄기 명령 전송`);
          await this.sendCommand('Off');
        });

    // only thinq2 support door lock status
    this.serviceDoorLock = accessory.getService(LockMechanism);
    // avoid using `in` against an optionally-chained value — ensure objects exist first
    if (this.config.washer_door_lock && device.platform === PlatformType.ThinQ2
        && device.snapshot && device.snapshot.washerDryer && ('doorLock' in device.snapshot.washerDryer)) {
      if (!this.serviceDoorLock) {
        this.serviceDoorLock = accessory.addService(LockMechanism, device.name + ' - Door');
        this.serviceDoorLock.addOptionalCharacteristic(Characteristic.ConfiguredName);
        this.serviceDoorLock.updateCharacteristic(Characteristic.ConfiguredName, device.name + ' - Door');
      }

      this.serviceDoorLock.getCharacteristic(Characteristic.LockCurrentState)
          .updateValue(LockCurrentState.UNSECURED)
          .onSet(this.setActive.bind(this))
          .setProps({
            minValue: 0,
            maxValue: 3,
            validValues: [LockCurrentState.UNSECURED, LockCurrentState.SECURED],
          });
      this.serviceDoorLock.getCharacteristic(Characteristic.LockTargetState)
          .onSet(this.setActive.bind(this))
          .updateValue(Characteristic.LockTargetState.UNSECURED);
    } else if (this.serviceDoorLock) {
      accessory.removeService(this.serviceDoorLock);
    }

    // finished
    this.serviceEventFinished = accessory.getService('Program Finished') || accessory.getService(ContactSensor);

    if (this.config.washer_trigger as boolean) {
      if (!this.serviceEventFinished) {
        this.serviceEventFinished = accessory.addService(ContactSensor, 'Program Finished', 'Program Finished');
        this.serviceEventFinished.addOptionalCharacteristic(Characteristic.ConfiguredName);
        this.serviceEventFinished.updateCharacteristic(Characteristic.ConfiguredName, 'Program Finished');
      }

      this.serviceEventFinished.setCharacteristic(Characteristic.Name, 'Program Finished');

      this.serviceEventFinished.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
    } else if (this.serviceEventFinished) {
      accessory.removeService(this.serviceEventFinished);
    }

    // tub clean coach
    this.serviceTubCleanMaintenance = accessory.getService('Tub Clean Coach');
    if (this.config.washer_tub_clean as boolean) {
      if (!this.serviceTubCleanMaintenance) {
        this.serviceTubCleanMaintenance = accessory.addService(OccupancySensor, 'Tub Clean Coach', 'Tub Clean Coach');
        this.serviceTubCleanMaintenance.addOptionalCharacteristic(Characteristic.ConfiguredName);
        this.serviceTubCleanMaintenance.updateCharacteristic(Characteristic.ConfiguredName, 'Tub Clean Coach');
      }

      this.serviceTubCleanMaintenance.setCharacteristic(Characteristic.Name, 'Tub Clean Coach');

      this.serviceTubCleanMaintenance.updateCharacteristic(Characteristic.OccupancyDetected, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);

      this.serviceTubCleanMaintenance.setCharacteristic(Characteristic.Name, 'Tub Clean Coach');
      this.serviceTubCleanMaintenance.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
          .setProps({
            validValues: [0], // single press
          });
    } else if (this.serviceTubCleanMaintenance) {
      accessory.removeService(this.serviceTubCleanMaintenance);
    }
  }

  public get Status() {
    return new WasherDryerStatus(this.accessory.context.device.snapshot?.washerDryer, this.accessory.context.device.deviceModel);
  }

  public get config() {
    return Object.assign({}, {
      washer_trigger: false,
      washer_door_lock: false,
      washer_tub_clean: false,
    }, super.config);
  }

  async setActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const isTargetStart = value === this.platform.Characteristic.Active.ACTIVE;

    if (!this.Status.isRemoteStartEnable && isTargetStart) {
      this.logger.warn(`[${device.name}] 원격 제어 비활성 상태`);
      setTimeout(() => this.updateAccessoryCharacteristic(device), 500);
      return;
    }

    try {
      const command = isTargetStart ? 'Start' : 'Pause';
      await this.sendCommand(command);
      this.logger.info(`[${device.name}] ${command} 명령 전송 성공`);
    } catch (err) {
      this.logger.error(`[${device.name}] 명령 전송 실패`, err);
      // 실패했을 때만 UI 복구
      setTimeout(() => this.updateAccessoryCharacteristic(device), 1000);
    }
  }

  protected async sendCommand(command: string) {
    const device: Device = this.accessory.context.device;

    if (device.platform === PlatformType.ThinQ1) { // ThinQ 1세대
      return await this.platform.ThinQ.thinq1DeviceControl(device, 'Operation', command);
    } else { // ThinQ 2세대
      return await this.platform.ThinQ.deviceControl(device.id, { command }, 'Operation');
    }
  }

  public updateAccessoryCharacteristic(device: Device) {
    super.updateAccessoryCharacteristic(device);
    const { Characteristic } = this.platform;

    this.serviceWasherDryer?.updateCharacteristic(Characteristic.Active, this.Status.isPowerOn ? 1 : 0);
    this.serviceWasherDryer?.updateCharacteristic(Characteristic.InUse, this.Status.isRunning ? 1 : 0);

    const currentRemaining = this.Status.remainDuration;
    if (this.serviceWasherDryer?.getCharacteristic(Characteristic.RemainingDuration).value !== currentRemaining) {
      this.serviceWasherDryer?.updateCharacteristic(Characteristic.RemainingDuration, currentRemaining);
    }

    this.serviceWasherDryer?.updateCharacteristic(Characteristic.StatusFault,
        this.Status.isError ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT);

    if (this.config.washer_door_lock && this.serviceDoorLock) {
      this.serviceDoorLock.updateCharacteristic(Characteristic.LockCurrentState,
          this.Status.isDoorLocked ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED);
    }
  }

  public update(snapshot: any) {
    super.update(snapshot);

    const washerDryer = snapshot.washerDryer;
    if (!washerDryer) {
      return;
    }

    const {
      Characteristic: {
        ContactSensorState,
        OccupancyDetected,
      },
    } = this.platform;

    if (this.config.washer_trigger as boolean && this.serviceEventFinished
        && ('preState' in washerDryer || 'processState' in washerDryer) && 'state' in washerDryer) {

      if ((['END', 'COOLDOWN'].includes(washerDryer.state)
              && !NOT_RUNNING_STATUS.includes(washerDryer.preState || washerDryer.processState))
          || (this.isRunning && !this.Status.isRunning)) {

        this.serviceEventFinished.updateCharacteristic(ContactSensorState, ContactSensorState.CONTACT_NOT_DETECTED);
        this.isRunning = false;

        setTimeout(() => {
          this.serviceEventFinished?.updateCharacteristic(ContactSensorState, ContactSensorState.CONTACT_DETECTED);
        }, 10000 * 60);
      }

      if (this.Status.isRunning && !this.isRunning) {
        this.serviceEventFinished?.updateCharacteristic(ContactSensorState, ContactSensorState.CONTACT_DETECTED);
        this.isRunning = true;
      }
    }

    if ('TCLCount' in washerDryer && this.serviceTubCleanMaintenance) {
      if (this.Status.TCLCount >= 30) {
        this.serviceTubCleanMaintenance.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_DETECTED);
      } else {
        this.serviceTubCleanMaintenance.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED);
      }
    }
  }
}

export class WasherDryerStatus {
  constructor(public data: any, protected deviceModel: DeviceModel) {
  }

  public get isPowerOn() {
    return !['POWEROFF', 'POWERFAIL'].includes(this.data?.state);
  }

  public get isRunning() {
    return this.isPowerOn && !NOT_RUNNING_STATUS.includes(this.data?.state);
  }

  public get isError() {
    return this.data?.state === 'ERROR';
  }

  public get isRemoteStartEnable() {
    const remoteStartValue = this.deviceModel.lookupMonitorName('remoteStart', '@CP_ON_EN_W');
    return this.data?.remoteStart === (remoteStartValue || 'REMOTE_START_ON');
  }

  public get isDoorLocked() {
    const current = this.deviceModel.lookupMonitorName('doorLock', '@CP_ON_EN_W');
    if (current === null) {
      return this.data.doorLock === 'DOORLOCK_ON';
    }

    return this.data.doorLock === current;
  }

  public get remainDuration() {
    const remainTimeHour = this.data?.remainTimeHour || 0,
        remainTimeMinute = this.data?.remainTimeMinute || 0;

    return this.isRunning ? (remainTimeHour * 3600 + remainTimeMinute * 60) : 0;
  }

  public get TCLCount() {
    return Math.min(parseInt(this.data?.TCLCount || 0), 30);
  }
}
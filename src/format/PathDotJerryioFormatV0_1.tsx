import { makeAutoObservable, reaction, action, intercept } from "mobx";
import { getAppStores } from "../core/MainApp";
import { ValidateNumber, makeId } from "../core/Util";
import { Quantity, UnitConverter, UnitOfLength } from "../core/Unit";
import { GeneralConfig, PathConfig, convertGeneralConfigUOL, convertPathConfigPointDensity } from "./Config";
import { Format, PathFileData } from "./Format";
import { NumberRange, RangeSlider, ValidateNumberRange } from "../component/RangeSlider";
import { Box, Typography } from "@mui/material";
import { CancellableCommand, HistoryEventMap, UpdateProperties } from "../core/Command";
import { Exclude, Expose, Type } from "class-transformer";
import { IsBoolean, IsObject, IsPositive, ValidateNested } from "class-validator";
import { PointCalculationResult, getPathPoints } from "../core/Calculation";
import { Path, Segment } from "../core/Path";
import { isCoordinateWithHeading } from "../core/Coordinate";
import { FieldImageOriginType, FieldImageSignatureAndOrigin, getDefaultBuiltInFieldImage } from "../core/Asset";

// observable class
class GeneralConfigImpl implements GeneralConfig {
  @IsPositive()
  @Expose()
  robotWidth: number = 30;
  @IsPositive()
  @Expose()
  robotHeight: number = 30;
  @IsBoolean()
  @Expose()
  robotIsHolonomic: boolean = false;
  @IsBoolean()
  @Expose()
  showRobot: boolean = false;
  @ValidateNumber(num => num > 0 && num <= 1000) // Don't use IsEnum
  @Expose()
  uol: UnitOfLength = UnitOfLength.Centimeter;
  @IsPositive()
  @Expose()
  pointDensity: number = 2;
  @IsPositive()
  @Expose()
  controlMagnetDistance: number = 5;
  @Type(() => FieldImageSignatureAndOrigin)
  @ValidateNested()
  @IsObject()
  @Expose()
  fieldImage: FieldImageSignatureAndOrigin<FieldImageOriginType> =
    getDefaultBuiltInFieldImage().getSignatureAndOrigin();

  @Exclude()
  private format_: PathDotJerryioFormatV0_1;

  constructor(format: PathDotJerryioFormatV0_1) {
    this.format_ = format;
    makeAutoObservable(this);

    reaction(
      () => this.uol,
      action((newUOL: UnitOfLength, oldUOL: UnitOfLength) => {
        convertGeneralConfigUOL(this, oldUOL);
      })
    );

    intercept(this, "fieldImage", change => {
      const { app, assetManager } = getAppStores();

      if (app.gc === this && assetManager.getAssetBySignature(change.newValue.signature) === undefined) {
        change.newValue = getDefaultBuiltInFieldImage().getSignatureAndOrigin();
      }

      return change;
    });
  }

  get format() {
    return this.format_;
  }

  getConfigPanel() {
    return <></>;
  }
}

// observable class
class PathConfigImpl implements PathConfig {
  @ValidateNumberRange(-Infinity, Infinity)
  @Expose()
  speedLimit: NumberRange = {
    minLimit: { value: 0, label: "0" },
    maxLimit: { value: 600, label: "600" },
    step: 1,
    from: 40,
    to: 120
  };
  @ValidateNumberRange(-Infinity, Infinity)
  @Expose()
  bentRateApplicableRange: NumberRange = {
    minLimit: { value: 0, label: "0" },
    maxLimit: { value: 4, label: "4" },
    step: 0.01,
    from: 1.4,
    to: 1.8
  };

  @Exclude()
  readonly format: PathDotJerryioFormatV0_1;

  @Exclude()
  public path!: Path;

  constructor(format: PathDotJerryioFormatV0_1) {
    this.format = format;
    makeAutoObservable(this);

    reaction(
      () => format.getGeneralConfig().pointDensity,
      action((val: number, oldVal: number) => {
        convertPathConfigPointDensity(this, oldVal, val);
      })
    );

    // ALGO: Convert the default parameters to the current point density
    // ALGO: This is only used when adding a new path
    // ALGO: When loading path config, the configuration will be set/overwritten after this constructor
    convertPathConfigPointDensity(this, 2, format.getGeneralConfig().pointDensity);
  }

  getConfigPanel() {
    const { app } = getAppStores();

    return (
      <>
        <Box className="panel-box">
          <Typography>Min/Max Speed</Typography>
          <RangeSlider
            range={this.speedLimit}
            onChange={(from, to) =>
              app.history.execute(
                `Change path ${this.path.uid} min/max speed`,
                new UpdateProperties(this.speedLimit, { from, to })
              )
            }
          />
        </Box>
        <Box className="panel-box">
          <Typography>Bent Rate Applicable Range</Typography>
          <RangeSlider
            range={this.bentRateApplicableRange}
            onChange={(from, to) =>
              app.history.execute(
                `Change path ${this.path.uid} bent rate applicable range`,
                new UpdateProperties(this.bentRateApplicableRange, { from, to })
              )
            }
          />
        </Box>
      </>
    );
  }
}

// observable class
export class PathDotJerryioFormatV0_1 implements Format {
  isInit: boolean = false;
  uid: string;

  private gc = new GeneralConfigImpl(this);
  private readonly events = new Map<keyof HistoryEventMap<CancellableCommand>, Set<Function>>();

  constructor() {
    this.uid = makeId(10);
    makeAutoObservable(this);
  }

  createNewInstance(): Format {
    return new PathDotJerryioFormatV0_1();
  }

  getName(): string {
    return "path.jerryio v0.1.x (cm, rpm)";
  }

  init(): void {
    if (this.isInit) return;
    this.isInit = true;
  }

  getGeneralConfig(): GeneralConfig {
    return this.gc;
  }

  createPath(...segments: Segment[]): Path {
    return new Path(new PathConfigImpl(this), ...segments);
  }

  getPathPoints(path: Path): PointCalculationResult {
    return getPathPoints(path, new Quantity(this.gc.pointDensity, this.gc.uol));
  }

  recoverPathFileData(fileContent: string): PathFileData {
    throw new Error("Unable to recover path file data from this format, try other formats?");
  }

  exportPathFile(): string {
    const { app } = getAppStores();

    let rtn = "";

    const uc = new UnitConverter(app.gc.uol, UnitOfLength.Centimeter);
    const density = new Quantity(app.gc.pointDensity, app.gc.uol);

    for (const path of app.paths) {
      rtn += `#PATH-POINTS-START ${path.name}\n`;

      const points = getPathPoints(path, density).points;

      for (const point of points) {
        const x = uc.fromAtoB(point.x).toUser();
        const y = uc.fromAtoB(point.y).toUser();
        if (isCoordinateWithHeading(point)) rtn += `${x},${y},${point.speed.toUser()},${point.heading}\n`;
        else rtn += `${x},${y},${point.speed.toUser()}\n`;
      }
    }

    rtn += "#PATH.JERRYIO-DATA " + JSON.stringify(app.exportPathFileData());

    return rtn;
  }

  addEventListener<K extends keyof HistoryEventMap<CancellableCommand>, T extends CancellableCommand>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): void {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type)!.add(listener);
  }

  removeEventListener<K extends keyof HistoryEventMap<CancellableCommand>, T extends CancellableCommand>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): void {
    if (!this.events.has(type)) return;
    this.events.get(type)!.delete(listener);
  }

  fireEvent(
    type: keyof HistoryEventMap<CancellableCommand>,
    event: HistoryEventMap<CancellableCommand>[keyof HistoryEventMap<CancellableCommand>]
  ) {
    if (!this.events.has(type)) return;
    for (const listener of this.events.get(type)!) {
      listener(event);
    }
  }
}

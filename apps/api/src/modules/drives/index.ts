// modules/drives/index.ts
// Barrel: colleges, rounds and drives on the Prisma repository. `drives` is the
// service other modules use; `drivesRepository.findDrive/findDriveFor` are the
// internal reads (promotion, exam engine).

import { drivesRepository, driveExamSettings } from './drives.repository.js';
import { createDrivesService } from './drives.service.js';

export { createDrivesRouter } from './drives.routes.js';
export { createDrivesService, toDriveDto, toRoundDto } from './drives.service.js';
export type { DrivesService, DrivesRepository, DriveRow, RoundRow, CollegeRow, Actor } from './drives.service.js';
export { drivesRepository, driveExamSettings };

export const drives = createDrivesService(drivesRepository);

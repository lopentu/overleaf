// @ts-check
import mongoose from '../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const GitHubSyncProjectStatesSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', required: true, unique: true },
    repoFullName: { type: String, required: true },
    defaultBranchName: { type: String, default: null },
    mergeStatus: {
      type: String,
      enum: ['clean', 'conflict', 'diverged'],
      default: 'clean',
    },
    lastSyncCommit: { type: String, default: null },
    lastSyncVersion: { type: Number, default: null },
    unmergedBranchName: { type: String, default: null },
    unmergedBranchHead: { type: String, default: null },
    conflictVersion: { type: Number, default: null },
  },
  {
    collection: 'githubSyncProjectStates',
    minimize: false,
    writeConcern: { w: 'majority' },
  }
)

export const GitHubSyncProjectStates = mongoose.model(
  'GitHubSyncProjectStates',
  GitHubSyncProjectStatesSchema
)

const exportClaimSchema = new Schema(
  {
    _id: { type: ObjectId, required: true },
    claimId: { type: String, required: true },
    userId: { type: ObjectId, required: true },
    repositoryName: { type: String, required: true },
    organization: String,
    startedAt: { type: Date, required: true },
  },
  {
    collection: 'githubSyncExportClaims',
    versionKey: false,
    writeConcern: { w: 'majority' },
  }
)

export const GitHubSyncExportClaims = mongoose.model(
  'GitHubSyncExportClaims',
  exportClaimSchema
)

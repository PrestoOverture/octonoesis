import { describe, expect, it } from 'bun:test'
import { assessBucket } from '../../../../src/memory/calibration/policy.ts'
import type { BucketStats } from '../../../../src/memory/calibration/stats.ts'

describe('Fails-Safe Calibration Policy', () => {
  it("should return 'insufficient-data' when total attempts < 3", () => {
    const stats: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 2,
      first_attempt_success: 2,
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1,
    }
    expect(assessBucket(stats)).toBe('insufficient-data')
  })

  it("should return 'review-recommended' when total attempts is 3 or 4", () => {
    const stats3: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 3,
      first_attempt_success: 3,
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1,
    }
    expect(assessBucket(stats3)).toBe('review-recommended')

    const stats4: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 4,
      first_attempt_success: 4,
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1,
    }
    expect(assessBucket(stats4)).toBe('review-recommended')
  })

  it("should return 'confident' when total attempts >= 5 and success rate >= 70%", () => {
    const stats: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 5,
      first_attempt_success: 4, // 80% success
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1,
    }
    expect(assessBucket(stats)).toBe('confident')
  })

  it("should return 'review-recommended' when total attempts >= 5 and success rate < 50%", () => {
    const stats: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 5,
      first_attempt_success: 2, // 40% success
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1.5,
    }
    expect(assessBucket(stats)).toBe('review-recommended')
  })

  it("should return 'review-recommended' when total attempts >= 5 and success rate is between 50% and 70%", () => {
    const stats: BucketStats = {
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      total_attempts: 5,
      first_attempt_success: 3, // 60% success
      user_modifications: 0,
      user_reverts: 0,
      avg_attempts_to_resolve: 1.2,
    }
    expect(assessBucket(stats)).toBe('review-recommended')
  })
})

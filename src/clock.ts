export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => new Date() };

export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

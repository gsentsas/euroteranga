/**
 * Local blocklist. Most entries of public "most common passwords" lists are
 * shorter than the 15-character minimum and are rejected by length already;
 * this list targets well-known long ones. Entries are compact: lowercase,
 * without spaces or separators (the policy compacts input the same way).
 */
export const COMMON_LONG_PASSWORDS: ReadonlySet<string> = new Set([
  'passwordpassword',
  'passwordpassword1',
  'password12345678',
  'password123456789',
  'passwordpassword123',
  'mypasswordisstrong',
  'thisismypassword',
  'iloveyouiloveyou',
  'iloveyouforever',
  'letmeinletmein',
  'letmeinletmein123',
  'welcomewelcome',
  'welcomewelcome123',
  'trustno1trustno1',
  'administrator123',
  'administrator1234',
  'administrateur123',
  'motdepassemotdepasse',
  'motdepasse123456',
  'motdepasse1234567',
  'monmotdepasse123',
  'jetaime123456789',
  'correcthorsebatterystaple',
  'changemechangeme',
  'changeme12345678',
  'superman12345678',
  'football12345678',
  'baseball12345678',
  'starwarsstarwars',
  'dragondragondragon',
  'sunshine12345678',
  'princess12345678',
  'qwerty1234567890',
  'azerty1234567890',
  '1q2w3e4r5t6y7u8i',
  '1q2w3e4r5t6y7u8i9o',
  'q1w2e3r4t5y6u7i8',
  'zaq12wsxcde34rfv',
  '1qaz2wsx3edc4rfv',
]);

/**
 * Keyboard and alphabet sequences (and their reverses): any password that is
 * a run of one of these is refused.
 */
const FORWARD = [
  '01234567890123456789012345678901234567890',
  'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm',
  'azertyuiopqsdfghjklmwxcvbnazertyuiopqsdfghjklmwxcvbn',
  'qwertzuiopasdfghjklyxcvbnmqwertzuiopasdfghjklyxcvbnm',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
];
export const KEYBOARD_SEQUENCES: readonly string[] = [
  ...FORWARD,
  ...FORWARD.map((sequence) => [...sequence].reverse().join('')),
];

/** Terms specific to the service, refused anywhere in a password. */
export const SERVICE_TERMS: readonly string[] = ['euroteranga'];

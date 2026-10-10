import { z } from 'zod';

// Fields use .nullable() rather than .optional(): some providers' structured-output
// modes (e.g. OpenAI strict mode) require every property to be present.

const LocalTime = z
  .string()
  .describe('Local time exactly as written on the page, formatted YYYY-MM-DDTHH:mm (24-hour)');

export const EventInfoSchema = z.object({
  name: z.string().describe('Name of the hackathon'),
  summary: z.string().describe('2-4 sentences: what the event is, when and where, and any theme or tracks'),
  venue: z.string().nullable().describe('Venue name and city, or "Online"'),
  timezone: z
    .string()
    .nullable()
    .describe('IANA time zone of the event, e.g. America/New_York when times say EDT/EST'),
  schedule: z
    .array(
      z.object({
        title: z.string(),
        kind: z.enum(['ceremony', 'workshop', 'meal', 'activity', 'other']),
        start: LocalTime,
        end: LocalTime.nullable(),
        location: z.string().nullable(),
        description: z.string().nullable().describe('At most one short sentence'),
      }),
    )
    .describe('Things happening during the event: ceremonies, workshops, meals, activities'),
  deadlines: z
    .array(
      z.object({
        title: z.string().describe('e.g. "Submissions due", "Judging", "Winners announced"'),
        at: LocalTime,
        description: z.string().nullable(),
      }),
    )
    .describe('Cutoffs and milestones teams must meet or know about'),
  requirements: z
    .array(z.string())
    .describe('What a team must do or submit to be eligible, as short imperative bullets'),
  judgingCriteria: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      weight: z.string().nullable().describe('As stated, e.g. "25%" or "1-5 points"; null if not stated'),
    }),
  ),
  rules: z.array(z.string()).describe('Up to 8 key rules a team should know'),
});

export type EventInfo = z.infer<typeof EventInfoSchema>;

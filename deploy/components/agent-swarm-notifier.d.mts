export type CloudWatchAlarm = {
  AlarmName: string;
  AlarmDescription?: string;
  NewStateValue: string;
  OldStateValue: string;
  NewStateReason: string;
};

export declare const formatAlarm: (alarm: CloudWatchAlarm) => string;

export declare const handler: (event: {
  Records: { Sns: { Message: string } }[];
}) => Promise<void>;

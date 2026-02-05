import axios from "axios";

type NewRelicResponse = {
  data: {
    actor: {
      account: {
        nrql: {
          results: any[];
        };
      };
    };
  };
};

export const searchNewRelicLogs = async (nrql: string): Promise<any[]> => {
  const apiKey = process.env.NEW_RELIC_API_KEY;
  const accountId = process.env.NEW_RELIC_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    console.log(
      "Skipping New Relic search (NEW_RELIC_API_KEY or NEW_RELIC_ACCOUNT_ID not set)"
    );
    return [];
  }

  const response = await axios.post<NewRelicResponse>(
    "https://api.newrelic.com/graphql",
    {
      query: `
        {
          actor {
            account(id: ${accountId}) {
              nrql(query: "${nrql}") {
                results
              }
            }
          }
        }
      `,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "API-Key": apiKey,
      },
    }
  );

  return response.data.data.actor.account.nrql.results;
};

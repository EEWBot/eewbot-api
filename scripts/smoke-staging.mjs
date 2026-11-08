import { smokeApi } from './smoke-api.mjs'

await smokeApi('staging', {
  clientId: process.env.ACCESS_CLIENT_ID,
  clientSecret: process.env.ACCESS_CLIENT_SECRET,
})

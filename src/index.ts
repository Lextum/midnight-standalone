/*
 * This file is the main driver for the Midnight bulletin board example.
 * The entry point is the run function, at the end of the file.
 * We expect the startup files (testnet-remote.ts, standalone.ts, etc.) to
 * call run with some specific configuration that sets the network addresses
 * of the servers this file relies on.
 */

import { nativeToken } from '@midnight-ntwrk/ledger';
import { getZswapNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { type Resource, WalletBuilder } from '@midnight-ntwrk/wallet';
import { type Wallet } from '@midnight-ntwrk/wallet-api';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import type { DockerComposeEnvironment, StartedDockerComposeEnvironment } from 'testcontainers';
import { type Config, StandaloneConfig } from './config.js';

/* **********************************************************************
 * mainLoop: the main interactive menu of the bulletin board CLI.
 * Before starting the loop, the user is prompted to deploy a new
 * contract or join an existing one.
 */

const MAIN_LOOP_QUESTION = `
You can do one of the following:
  1. Send DUST to another wallet
  2. Exit
Which would you like to do? `;

const mainLoop = async (wallet: Wallet & Resource, rli: Interface, logger: Logger): Promise<void> => {
  try {
    while (true) {
      const choice = await rli.question(MAIN_LOOP_QUESTION);
      switch (choice) {
        case '1': {
          const to = await rli.question('Enter the recipient address: ');
          const amount = BigInt(await rli.question('Enter the amount to send: '));
          if (wallet === null) {
            logger.error('Wallet is not initialized');
            break;
          }
          await sendDUST(wallet, amount, to, logger);
          break;
        }
        case '2':
          logger.info('Exiting...');
          return;
        default:
          logger.error(`Invalid choice: ${choice}`);
      }
    }
  } finally {
    // While we allow errors to bubble up to the 'run' function, we will always need to dispose of the state
    // subscription when we exit.
  }
};

/* **********************************************************************
 * waitForFunds: wait for tokens to appear in a wallet.
 *
 * This is an interesting example of watching the stream of states
 * coming from the pub-sub indexer.  It watches both
 *  1. how close the state is to present reality and
 *  2. the balance held by the wallet.
 */

const waitForFunds = (wallet: Wallet, logger: Logger) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const scanned = state.syncProgress?.synced ?? 0n;
        const total = state.syncProgress?.total.toString() ?? 'unknown number';
        logger.info(`Wallet processed ${scanned} indices out of ${total}`);
      }),
      Rx.filter((state) => {
        // Let's allow progress only if wallet is close enough
        const synced = state.syncProgress?.synced ?? 0n;
        const total = state.syncProgress?.total ?? 1_000n;
        return total - synced < 100n;
      }),
      Rx.map((s) => s.balances[nativeToken()] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

/* **********************************************************************
 * buildWalletAndWaitForFunds: the main function that creates a wallet
 * and waits for tokens to appear in it.  The various "buildWallet"
 * functions all arrive here after collecting information for the
 * arguments.
 */

const buildWalletAndWaitForFunds = async (
  { indexer, indexerWS, node, proofServer }: Config,
  logger: Logger,
  seed: string,
): Promise<Wallet & Resource> => {
  const wallet = await WalletBuilder.buildFromSeed(
    indexer,
    indexerWS,
    proofServer,
    node,
    seed,
    getZswapNetworkId(),
    'warn',
  );
  wallet.start();
  const state = await Rx.firstValueFrom(wallet.state());
  logger.info(`Your wallet seed is: ${seed}`);
  logger.info(`Your wallet address is: ${state.address}`);
  let balance = state.balances[nativeToken()];
  if (balance === undefined || balance === 0n) {
    logger.info(`Your wallet balance is: 0`);
    logger.info(`Waiting to receive tokens...`);
    balance = await waitForFunds(wallet, logger);
  }
  logger.info(`Your wallet balance is: ${balance}`);
  return wallet;
};

/* **********************************************************************
 * buildWallet: unless running in a standalone (offline) mode,
 * prompt the user to tell us whether to create a new wallet
 * or recreate one from a prior seed.
 */

const buildWallet = async (config: Config, rli: Interface, logger: Logger): Promise<(Wallet & Resource) | null> => {
  // This seed gives access to tokens minted in the genesis block of a local development node
  // only used in standalone networks to build a wallet with initial funds.
  const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000042';
  return await buildWalletAndWaitForFunds(config, logger, GENESIS_MINT_WALLET_SEED);
};

const mapContainerPort = (env: StartedDockerComposeEnvironment, url: string, containerName: string) => {
  const mappedUrl = new URL(url);
  const container = env.getContainer(containerName);

  mappedUrl.port = String(container.getFirstMappedPort());

  return mappedUrl.toString().replace(/\/+$/, '');
};

/* **********************************************************************
 * run: the main entry point that starts the whole bulletin board CLI.
 *
 * If called with a Docker environment argument, the application
 * will wait for Docker to be ready before doing anything else.
 */

export const run = async (config: Config, logger: Logger, dockerEnv?: DockerComposeEnvironment): Promise<void> => {
  const rli = createInterface({ input, output, terminal: true });
  let env;
  if (dockerEnv !== undefined) {
    logger.info('Starting docker environment');
    env = await dockerEnv.up();

    if (config instanceof StandaloneConfig) {
      config.indexer = mapContainerPort(env, config.indexer, 'standalone-indexer');
      config.indexerWS = mapContainerPort(env, config.indexerWS, 'standalone-indexer');
      config.node = mapContainerPort(env, config.node, 'standalone-node');
      config.proofServer = mapContainerPort(env, config.proofServer, 'standalone-proof-server');
    }
  }
  const wallet = await buildWallet(config, rli, logger);
  try {
    if (wallet !== null) {
      await mainLoop(wallet, rli, logger);
    }
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Found error '${e.message}'`);
      logger.info('Exiting...');
      logger.debug(`${e.stack}`);
    } else {
      throw e;
    }
  } finally {
    try {
      rli.close();
      rli.removeAllListeners();
    } catch (e) {
    } finally {
      try {
        if (wallet !== null) {
          await wallet.close();
        }
      } catch (e) {
      } finally {
        try {
          if (env !== undefined) {
            await env.down();
            logger.info('Goodbye');
            process.exit(0);
          }
        } catch (e) {}
      }
    }
  }
};
async function sendDUST(wallet: Wallet & Resource, amount: bigint, to: string, logger: Logger) {
  const transferRecipe = await wallet.transferTransaction([
    {
      amount: amount,
      receiverAddress: to,
      type: nativeToken(), // tDUST token type
    },
  ]);
  logger.info(`Transfer recipe: ${JSON.stringify(transferRecipe)}`);
  const provenTransaction = await wallet.proveTransaction(transferRecipe);
  const submittedTransaction = await wallet.submitTransaction(provenTransaction);
}

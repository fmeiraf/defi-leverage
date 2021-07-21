import { MikroORM } from "@mikro-orm/core";
import { Protocol } from "../../entities/Protocol";
import config from "../../mikro-orm.config";
import { getLogSet } from "./queries";
import _ from "lodash";
import chalk from "chalk";
import { User } from "../../entities/User";
import { Token } from "../../entities/Token";
import { Vault } from "../../entities/Vault";

import { ethers } from "ethers";
import { ilkRegistryAddress } from "../../constants";
import { provider } from "../../rpc_client/client";
import ilkRegistryABI from "../../ethereum/ABIs/IlkRegistry.json";
import erc20ABI from "../../ethereum/ABIs/ERC20.json";

export async function dbEntryChecker(
  dbInstance: any,
  dbEntity: any,
  entryValue: any
) {
  const dbEntry = await dbInstance.em.findOne(dbEntity, entryValue);
  const isOnDb = dbEntry === null ? false : true;
  return [dbEntry, isOnDb];
}

async function addNewUser(dbInstance: any, userAddress: string) {
  const newUser = await dbInstance.em.create(User, {
    user_address: userAddress,
  });
  await dbInstance.em.persistAndFlush(newUser);
  console.log(
    chalk.magentaBright(`Added new user to database: ${userAddress}`)
  );
  return newUser;
}

async function addNewCollateral(
  dbInstance: any,
  tokenName: string,
  liquidationRatio: number
) {
  const ilkRegistry = new ethers.Contract(
    ilkRegistryAddress,
    ilkRegistryABI,
    provider
  );

  const tokenQueryILK = await ilkRegistry.ilkData(
    ethers.utils.formatBytes32String(tokenName)
  );
  const tokenAddress = tokenQueryILK.gem;

  const ERC20 = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const tokenCode = await ERC20.symbol();
  const tokenDecimals = await ERC20.decimals();

  const newCollateral = await dbInstance.em.create(Token, {
    token_address: tokenAddress,
    token_ERC_code: tokenCode,
    token_code_on_protocol: tokenName,
    decimals: tokenDecimals,
    liquidation_ratio_maker: liquidationRatio,
  });

  await dbInstance.em.persistAndFlush(newCollateral);
  console.log(chalk.magentaBright(`Added new token to database: ${tokenName}`));
  return newCollateral;
}

async function handleUserCollateralCheck(
  dbInstance: any,
  vaultData: any,
  userCheck: boolean,
  currentUserObj: any,
  collateralCheck: boolean,
  currentCollateralObj: any
) {
  let finalUser;
  let finalCollateral;

  if (userCheck === false) {
    finalUser = await addNewUser(dbInstance, vaultData.vault.owner.address);
  } else {
    finalUser = currentUserObj;
  }

  if (collateralCheck === false) {
    finalCollateral = await addNewCollateral(
      dbInstance,
      vaultData.vault.collateralType.id,
      vaultData.vault.collateralType.liquidationRatio
    );
  } else {
    finalCollateral = currentCollateralObj;
  }

  return [finalUser, finalCollateral];
}

export default async () => {
  const orm = await MikroORM.init(config);

  while (true) {
    const makerInstance = await orm.em.findOne(Protocol, {
      name: "makerDAO",
    });

    console.log("back on top");

    if (makerInstance === null) {
      console.log(chalk.red(`Couldn't find makerDAO on protocol table`));
      break;
    }

    //run query until query.data.length === 0
    const data = await getLogSet(Number(makerInstance.last_updated_block));
    console.log(data.length);
    let blockLogs: any[] = [];
    if (data.length > 0) {
      // create new vaults objects
      let lastBlockChecked = Number(makerInstance.last_updated_block);

      await _.forEach(data.slice(0, 1), async (vaultLog) => {
        const [storedVault, vaultDbCheck] = await dbEntryChecker(orm, Vault, {
          vault_address: vaultLog.vault.handler,
        });

        // checking and adding users and collaterals beforehand

        const [currentUser, userDbCheck] = await dbEntryChecker(orm, User, {
          user_address: vaultLog.vault.owner.address,
        });

        const [currentCollateral, collateralDbCheck] = await dbEntryChecker(
          orm,
          Token,
          {
            token_code_on_protocol: vaultLog.vault.collateralType.id,
          }
        );

        const [userE, collateralTokenE] = await handleUserCollateralCheck(
          orm,
          vaultLog,
          userDbCheck,
          currentUser,
          collateralDbCheck,
          currentCollateral
        );

        // VAULT insertions
        const dai = await orm.em.findOne(Token, { token_ERC_code: "DAI" });

        let finalVault;
        if (vaultDbCheck === false) {
          finalVault = orm.em.create(Vault, {
            user_id: userE,
            protocol_id: makerInstance,
            collateral_token_id: collateralTokenE,
            debt_token_id: dai,
            vault_address: vaultLog.vault.handler,
            debtAmount: parseFloat(vaultLog.vault.debt),
            collateralAmount: parseFloat(vaultLog.vault.collateral),
            liquidationPrice:
              parseFloat(vaultLog.vault.collateral) === 0
                ? 0
                : (parseFloat(vaultLog.vault.debt) *
                    collateralTokenE.liquidation_ratio_maker) /
                  parseFloat(vaultLog.vault.collateral),
          });
          console.log(
            chalk.magentaBright(
              `Added new vault to database, vault_address: ${vaultLog.vault.handler}`
            )
          );
        } else {
          storedVault.user_id = userE;
          storedVault.collateral_token_id = collateralTokenE;
          storedVault.debtAmount = parseFloat(vaultLog.vault.debt);
          storedVault.collateralAmount = parseFloat(vaultLog.vault.collateral);
          storedVault.liquidationPrice =
            parseFloat(vaultLog.vault.collateral) === 0
              ? 0
              : (parseFloat(vaultLog.vault.debt) *
                  collateralTokenE.liquidation_ratio_maker) /
                parseFloat(vaultLog.vault.collateral);
          finalVault = storedVault;
          console.log(
            chalk.blueBright(
              `Updated vault on database, vault_address: ${vaultLog.vault.handler}`
            )
          );
        }

        await orm.em.persistAndFlush(finalVault);
        lastBlockChecked = parseInt(vaultLog.block);
        console.log(vaultLog.block);
        console.log(`last block var is : ${lastBlockChecked}`);
        blockLogs.push(vaultLog.block);
      });

      //update lastUpdatedBlock on db
      console.log(`last block var is : ${lastBlockChecked}`);
      console.log(`last block ${blockLogs}`);
      makerInstance.last_updated_block = lastBlockChecked;

      await orm.em.persistAndFlush(makerInstance);
      console.log(
        chalk.blueBright(
          `Updated latest updated block on database, newest block: ${lastBlockChecked}`
        )
      );
    } else {
      console.log(
        chalk.yellow("There are no updates to be processed at this time.")
      );
      break;
    }
  }
};

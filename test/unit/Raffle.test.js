const { assert, expect } = require("chai")
const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle Unit Tests", function () {
          let raffle, vrfCoordinatorV2Mock, deployer, raffleEntranceFee, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"]) // deploys our contracts using js scripts
              raffle = await ethers.getContract("Raffle", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntraceFee()
              interval = await raffle.getInterval()
          })

          describe("constructor", function () {
              it("Initializes the Raffle correctly.", async function () {
                  // We make our tests have just 1 assert per "it" IDEALLY
                  const raffleState = await raffle.getRaffleState() // returns a Big Number, so we convert it to string below
                  assert(raffleState.toString(), "0")
                  assert(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterRaffle", function () {
              it("reverts when insufficient money is entered", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      "Raffle__NotEnoughETHEntered"
                  )
              })

              it("populates s_players when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const newPlayer = await raffle.getPlayer(0)
                  assert.equal(newPlayer, deployer)
              })

              it("emits an event after entrance", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })

              it("reverts when raffle is calculating", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  // We pretent to be Chainlink Keeper, we've made checkupKeep = true by
                  // 1. entering the raffle 2. entering a balance 3. passed the interval
                  // 4. calling performupkeep() and setting raffleState to CALCULATING inside it
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      "Raffle__NotOpen"
                  )
              })

              describe("checkupKeep", function () {
                  it("returns false if people haven't sent enough ETH", async function () {
                      // hasBalance condition
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const { upkeepNeeded } = raffle.callStatic.checkUpkeep([]) // callStatic simulates a txn call
                      await assert(!upkeepNeeded)
                  })

                  it("returns false if raffle is not open", async function () {
                      // raffleState condition
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      await raffle.performUpkeep([]) // or we can pass "0x" which is translated to [] by hardhat
                      const raffleState = await raffle.getRaffleState()
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                      assert.equal(raffleState.toString(), "1")
                      assert.equal(upkeepNeeded, false)
                  })

                  it("returns false if enough time hasn't passed", async () => {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() - 1])
                      await network.provider.request({ method: "evm_mine", params: [] })
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                      assert(!upkeepNeeded)
                  })

                  it("returns true if enough time has passed, has players, eth, and is open", async () => {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.request({ method: "evm_mine", params: [] })
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                      assert(upkeepNeeded)
                  })
              })

              describe("performUpkeep", function () {
                  it("it only runs when checkUpkeep is true", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const tx = await raffle.performUpkeep("0x")
                      assert(tx)
                  })

                  it("reverts when checkUpkeep is false", async function () {
                      await expect(raffle.performUpkeep([])).to.be.revertedWith(
                          "Raffle__UpkeepNotNeeded"
                      )
                  })

                  it("updates raffle state and calls vrfCoordinator", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const transactionResponse = await raffle.performUpkeep("0x")
                      const transactionReceipt = await transactionResponse.wait(1)
                      const requestId = transactionReceipt.events[1].args.requestId
                      const raffleState = raffle.getRaffleState()

                      assert(requestId.toNumber() > 0)
                      assert(raffleState.toString, "1")
                  })
              })

              describe("fulfillRandomWords", function () {
                  beforeEach(async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                  })

                  it("can only be called after performUpkeep()", async function () {
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                      ).to.be.revertedWith("nonexistent request")

                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                      ).to.be.revertedWith("nonexistent request")
                  })

                  it("picks the winner, reset the raffle/lottery, sends the money", async () => {
                      const additionalEntrances = 3 // to test
                      const startingIndex = 2
                      accounts = await ethers.getSigners()
                      for (let i = startingIndex; i < startingIndex + additionalEntrances; i++) {
                          // i = 2; i < 5; i=i+1
                          const accountConnectedRaffle = raffle.connect(accounts[i]) // Returns a new instance of the Raffle contract connected to player
                          await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                      }
                      const startingTimeStamp = await raffle.getLatestTimeStamp() // stores starting timestamp (before we fire our event)

                      // This will be more important for our staging tests...
                      await new Promise(async (resolve, reject) => {
                          raffle.once("WinnerPicked", async () => {
                              // event listener for WinnerPicked
                              console.log("WinnerPicked event fired!")
                              // assert throws an error if it fails, so we need to wrap
                              // it in a try/catch so that the promise returns event
                              // if it fails.
                              try {
                                  // Now lets get the ending values...
                                  const recentWinner = await raffle.getRecentWinner()
                                  console.log(recentWinner)
                                  console.log(accounts[0].address)
                                  console.log(accounts[1].address)
                                  console.log(accounts[2].address)
                                  console.log(accounts[3].address)

                                  const raffleState = await raffle.getRaffleState()
                                  const winnerBalance = await accounts[2].getBalance()
                                  const endingTimeStamp = await raffle.getLatestTimeStamp()
                                  await expect(raffle.getPlayer(0)).to.be.reverted
                                  // Comparisons to check if our ending values are correct:
                                  assert.equal(recentWinner.toString(), accounts[2].address)
                                  assert.equal(raffleState, 0)
                                  assert.equal(
                                      winnerBalance.toString(),
                                      startingBalance // startingBalance + ( (raffleEntranceFee * additionalEntrances) + raffleEntranceFee )
                                          .add(
                                              raffleEntranceFee
                                                  .mul(additionalEntrances)
                                                  .add(raffleEntranceFee)
                                          )
                                          .toString()
                                  )
                                  assert(endingTimeStamp > startingTimeStamp)
                                  resolve() // if try passes, resolves the promise
                              } catch (e) {
                                  console.log(e)
                                  reject(e) // if try fails, rejects the promise
                              }
                          })

                          const tx = await raffle.performUpkeep("0x")
                          const txReceipt = await tx.wait(1)
                          const startingBalance = await accounts[2].getBalance()
                          await vrfCoordinatorV2Mock.fulfillRandomWords(
                              txReceipt.events[1].args.requestId,
                              raffle.address
                          )
                      })
                  })
              })
          })
      })

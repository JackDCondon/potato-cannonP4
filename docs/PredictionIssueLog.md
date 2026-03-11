captured outcome using jcinventory.prediction.DebugLog = 1

LogJCInventoryUI: [DragStart] Item='Kael's Trembling Javelin' ItemTopLeftScreen=(1485.3,393.7) PressPos=(1528.0,442.0) DragOffset=(-42.7,-48.3) DecoratorScale=0.743
LogJCInventoryUI: [DragOver] CursorScreen=(1523.0,440.0) LocalPos=(152.7,164.4) zone rect accepts drag
LogJCInventoryUI: [DragOver] CursorScreen=(531.0,468.0) LocalPos=(425.3,182.0) zone rect accepts drag
LogJCInventoryUI: [DragOver] CursorScreen=(305.0,454.0) LocalPos=(121.1,163.2) zone rect accepts drag
LogJCInventoryUI: [DragOver] CursorScreen=(253.0,442.0) LocalPos=(51.1,147.0) zone rect accepts drag
LogJCInventoryUI: [DragOver] CursorScreen=(238.0,442.0) LocalPos=(30.9,147.0) zone rect accepts drag
LogJCInventoryUI: [DropZone] OnDrop received
LogJCInventoryUI: [DropPosition] CursorScreen=(238.0,442.0) DragOffset=(0.0,0.0) ItemTopLeftScreen=(238.0,442.0) -> LocalPos=(30.9,147.0)
LogJCInventoryUI: [DropZone] LocalPos=(30.9,147.0) Cols=6 Rows=5 SlotSize=100.0
LogJCInventoryUI: [HandleGridDrop] ENTER LocalPos=(30.9,147.0) Cols=6 Rows=5 SlotSize=100.0
LogJCInventoryUI: [HandleGridDrop] Item='Kael's Trembling Javelin' SrcComp=BackpackComponent SrcSlot=7 LocalPos=(30.9,147.0)->DstSlot=6
LogJCInventoryPrediction: [RequestTransferItem] Frame=6574 Time=17086299.0028 PredId=2 Item=C3FA006E48C1E0A4AD6C118F05C4ADC4 Src=BP_TopDownCharacter_C_0 Dst=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 Slot=6 Qty=1 Intra=0
LogJCInventoryPrediction: [RequestTransferItem] Frame=6574 PredId=2 PreFlightOutcome=0 SwapSlot=-1 MergeQty=0
LogJCInventoryPrediction: [AddPendingPrediction] Frame=6574 Time=17086299.0031 Comp=BP_TopDownCharacter_C_0 PredId=2 Type=0 Item=C3FA006E48C1E0A4AD6C118F05C4ADC4 Slot=7 Delta=-1 Rotated=0 PendingCount=1
LogJCInventoryPrediction: [AddPendingPrediction] Frame=6574 Time=17086299.0033 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 PredId=2 Type=0 Item=C3FA006E48C1E0A4AD6C118F05C4ADC4 Slot=6 Delta=1 Rotated=0 PendingCount=2
LogJCInventoryPrediction: [RebuildSimulated] Frame=6574 Time=17086299.0034 Comp=BP_TopDownCharacter_C_0 BEGIN Rev=1 ReplicatedEntries=1 PendingPredictions=1
LogJCInventoryPrediction: [RebuildSimulated] Frame=6574 Comp=BP_TopDownCharacter_C_0 END SimulatedEntries=1 PredictionsRemaining=1 (pruned 0)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Time=17086299.0038 Comp=BP_TopDownCharacter_C_0 BEGIN PendingCount=1 SimulatedCount=1
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Comp=BP_TopDownCharacter_C_0 Pass1-Remove PredId=2 Item=C3FA006E48C1E0A4AD6C118F05C4ADC4 Delta=-1 RemainingStack=0
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Comp=BP_TopDownCharacter_C_0 END SimulatedCount=0
LogJCInventoryPrediction: [RebuildSimulated] Frame=6574 Time=17086299.0042 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN Rev=348 ReplicatedEntries=8 PendingPredictions=2
LogJCInventoryPrediction: [RebuildSimulated] Frame=6574 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 PRUNING PredId=1 (ConfirmAtRev=348 <= CurrentRev=348)
LogJCInventoryPrediction: [RebuildSimulated] Frame=6574 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedEntries=8 PredictionsRemaining=1 (pruned 1)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Time=17086299.0046 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN PendingCount=1 SimulatedCount=8
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 Pass2-Add PredId=2 Item=C3FA006E48C1E0A4AD6C118F05C4ADC4 Slot=6 Qty=1
LogJCInventoryPrediction: [ReplayPredictions] Frame=6574 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedCount=9
LogJCInventoryPrediction: [RequestTransferItem] Frame=6574 PredId=2 PredictionsPushed SourcePendingCount=1 DestPendingCount=1 FiringRPC
LogJCInventoryUI: [HandleGridDrop] IntentRouter path: PredictionId=2 bHandled=1
LogJCInventoryUI: [HandleGridDrop] Final bHandled=1 SlotAfter=7
LogJCInventoryUI: [HandleGridDrop] RefreshGrid
LogJCInventoryUI: [DragEnd] Item='Kael's Trembling Javelin' bDropWasHandled=1 CursorScreen=(238.0,442.0)
LogJCInventoryPrediction: [RebuildSimulated] Frame=6615 Time=17086299.3605 Comp=BP_TopDownCharacter_C_0 BEGIN Rev=2 ReplicatedEntries=0 PendingPredictions=0
LogJCInventoryPrediction: [RebuildSimulated] Frame=6615 Comp=BP_TopDownCharacter_C_0 END SimulatedEntries=0 PredictionsRemaining=0 (pruned 0)
LogJCInventoryPrediction: [RebuildSimulated] Frame=6615 Time=17086299.3609 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN Rev=349 ReplicatedEntries=9 PendingPredictions=0
LogJCInventoryPrediction: [RebuildSimulated] Frame=6615 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedEntries=9 PredictionsRemaining=0 (pruned 0)
LogJCInventory: ServerRequestTransfer: success. PredId=2, SourceRev=2, DestRev=349.
LogJCInventoryPrediction: [ClientAckTransfer] Frame=6655 Time=17086299.6941 PredId=2 Result=0 SourceRev=2 DestRev=349
LogJCInventoryPrediction: [MarkPredictionConfirmed] Frame=6655 Time=17086299.6944 Comp=BP_TopDownCharacter_C_0 PredId=2 ConfirmAtRev=2 CurrentRev=1
LogJCInventoryPrediction: [MarkPredictionConfirmed] Frame=6655 Time=17086299.6945 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 PredId=2 ConfirmAtRev=349 CurrentRev=348
LogJCInventory: ClientAckTransfer: PredId=2 confirmed. SourceRev=2, DestRev=349.
LogJCInventoryPrediction: [PostReplicatedReceive] Frame=6658 Time=17086299.7200 Comp=BackpackComponent Entries=0 -- triggering reconcile
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Time=17086299.7202 Comp=BP_TopDownCharacter_C_0 BEGIN Rev=2 ReplicatedEntries=0 PendingPredictions=1
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_TopDownCharacter_C_0 PRUNING PredId=2 (ConfirmAtRev=2 <= CurrentRev=2)
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_TopDownCharacter_C_0 END SimulatedEntries=0 PredictionsRemaining=0 (pruned 1)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Time=17086299.7206 Comp=BP_TopDownCharacter_C_0 BEGIN PendingCount=0 SimulatedCount=0
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Comp=BP_TopDownCharacter_C_0 END SimulatedCount=0
LogJCInventoryPrediction: [OnRep_InventoryRevision] Frame=6658 Time=17086299.7213 Comp=BP_TopDownCharacter_C_0 Rev=2 -- triggering reconcile
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Time=17086299.7215 Comp=BP_TopDownCharacter_C_0 BEGIN Rev=2 ReplicatedEntries=0 PendingPredictions=0
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_TopDownCharacter_C_0 END SimulatedEntries=0 PredictionsRemaining=0 (pruned 0)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Time=17086299.7217 Comp=BP_TopDownCharacter_C_0 BEGIN PendingCount=0 SimulatedCount=0
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Comp=BP_TopDownCharacter_C_0 END SimulatedCount=0
LogJCInventoryPrediction: [PostReplicatedReceive] Frame=6658 Time=17086299.7225 Comp=ChestInventory Entries=9 -- triggering reconcile
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Time=17086299.7226 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN Rev=0 ReplicatedEntries=0 PendingPredictions=0
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedEntries=0 PredictionsRemaining=0 (pruned 0)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Time=17086299.7229 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN PendingCount=0 SimulatedCount=0
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedCount=0
LogJCInventoryPrediction: [OnRep_InventoryRevision] Frame=6658 Time=17086299.7231 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 Rev=349 -- triggering reconcile
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Time=17086299.7232 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN Rev=349 ReplicatedEntries=9 PendingPredictions=1
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 PRUNING PredId=2 (ConfirmAtRev=349 <= CurrentRev=349)
LogJCInventoryPrediction: [RebuildSimulated] Frame=6658 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedEntries=9 PredictionsRemaining=0 (pruned 1)
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Time=17086299.7235 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 BEGIN PendingCount=0 SimulatedCount=9
LogJCInventoryPrediction: [ReplayPredictions] Frame=6658 Comp=BP_ItemChest_C_UAID_60CF848A70DC86C202_2101822943 END SimulatedCount=9
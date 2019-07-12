// Load AI archetypes

var file = webRoot+"data/training/aiArchetypes.json?v=1";
var aiData = [];

$.getJSON( file, function( data ){
	aiData = data;
	console.log("AI data loaded ["+aiData.length+"]");
});

function TrainingAI(l, p, b){
	var level = l;
	var player = p;
	var battle = b;
	var gm = GameMaster.getInstance();
	var teamPool = [];
	var partySize = 3;
	var props = aiData[l];
	var generateRosterCallback;
	var self = this;

	var currentStrategy; // The current employed strategy to determine behavior
	var scenarios;

	var turnLastEvaluated = 0;

	if(level == 0){
		chargedMoveCount = 1;
	}

	// Generate a random roster of 6 given a cup and league

	this.generateRoster = function(size, callback){
		partySize = size;
		generateRosterCallback = callback;

		var league = battle.getCP();
		var cup = battle.getCup().name;

		if(! teamPool[league+""+cup]){
			gm.loadTeamData(league, cup, self.setTeamPool);
			return;
		}

		var pool = teamPool[league+""+cup];
		var slotBucket = [];
		var slots = [];

		// Put all the slots in bucket, multiple times for its weight value

		for(var i = 0; i < pool.length; i++){
			for(var n = 0; n < pool[i].weight; n++){
				slotBucket.push(pool[i].slot);
			}
		}

		// Draw 6 unique slots from the bucket

		for(var i = 0; i < 6; i++){
			var index = Math.floor(Math.random() * slotBucket.length);
			var slot = slotBucket[index];
			var synergies = pool.filter(obj => {
  				return obj.slot === slot
			})[0].synergies;
			slots.push(slot);

			// Add synergies to bucket to increase chances of picking them
			for(var n = 0; n < synergies.length; n++){
				if(slotBucket.indexOf(synergies[n]) > -1){
					slotBucket.push(synergies[n], synergies[n]);
				}
			}

			// Clear the selected value from the bucket
			var itemIndex = 0;
			while ((itemIndex = slotBucket.indexOf(slot, itemIndex)) > -1) {
			  slotBucket.splice(itemIndex, 1);
			}
		}

		// For each slot, pick a random Pokemon

		var roster = [];
		var selectedIds = []; // Array of Pokemon ID's to check to avoid duplicates

		for(var i = 0; i < slots.length; i++){
			// Grab the pool of Pokemon given the slot name
			var slotPool = pool.filter(obj => {
  				return obj.slot === slots[i]
			})[0].pokemon;
			var pokeBucket = [];

			for(var n = 0; n < slotPool.length; n++){
				var poke = slotPool[n];

				// Is this Pokemon valid to be added to the team?
				if((selectedIds.indexOf(poke.speciesId) === -1)&&(Math.abs(poke.difficulty - level) <= 1)){
					for(var j = 0; j < poke.weight; j++){
						pokeBucket.push(poke);
					}
				}
			}

			// Select a random poke from the bucket
			var index = Math.floor(Math.random() * pokeBucket.length);
			var poke = pokeBucket[index];

			var pokemon = new Pokemon(poke.speciesId, player.index, battle);
			pokemon.initialize(battle.getCP());

			pokemon.selectMove("fast", poke.fastMove);
			for(var n = 0; n < props.chargedMoveCount; n++){
				pokemon.selectMove("charged", poke.chargedMoves[n], n);
			}

			roster.push(pokemon);
			selectedIds.push(poke.speciesId);
		}

		player.setRoster(roster);
		generateRosterCallback();
	}

	// With a set roster, produce a team of 3

	this.generateTeam = function(opponentRoster){
		var roster = player.getRoster();
		var team = [];

		for(var i = 0; i < 3; i++){
			team.push(roster[i]);
		}

		player.setTeam(team);
	}

	// Set the pool of available Pokemon from data

	this.setTeamPool = function(league, cup, data){
		teamPool[league+""+cup] = data;
		self.generateRoster(partySize, generateRosterCallback);
	}

	// Evaluate the current matchup and decide a high level strategy

	this.evaluateMatchup = function(turn, pokemon, opponent, opponentPlayer){
		// Preserve current HP, energy, and stat boosts
		pokemon.startHp = pokemon.hp;
		pokemon.startEnergy = pokemon.energy;
		pokemon.startStatBuffs = [pokemon.statBuffs[0], pokemon.statBuffs[1]];
		pokemon.startCooldown = pokemon.cooldown;
		pokemon.startingShields = pokemon.shields;
		pokemon.baitShields = true;
		pokemon.farmEnergy = false;

		opponent.startHp = opponent.hp;
		opponent.startEnergy = opponent.energy;
		opponent.startStatBuffs = [opponent.statBuffs[0], opponent.statBuffs[1]];
		opponent.startCooldown = opponent.cooldown;
		opponent.startingShields = opponent.shields;
		opponent.baitShields = true;
		opponent.farmEnergy = false;

		// Sim multiple scenarios to help determine strategy

		scenarios = {};

		scenarios.bothBait = self.runScenario("BOTH_BAIT", pokemon, opponent);
		scenarios.neitherBait = self.runScenario("NEITHER_BAIT", pokemon, opponent);
		scenarios.noBait = self.runScenario("NO_BAIT", pokemon, opponent);
		scenarios.farm = self.runScenario("FARM", pokemon, opponent);

		var overallRating = (scenarios.bothBait.average + scenarios.neitherBait.average + scenarios.noBait.average) / 3;

		var options = [];
		var totalSwitchWeight = 0;

		if((self.hasStrategy("SWITCH_BASIC"))&&(player.getSwitchTimer() == 0)&&(player.getRemainingPokemon() > 1)){
			var switchWeight = Math.floor(Math.max((500 - overallRating) / 10, 0));
			options.push(new DecisionOption("SWITCH_BASIC", switchWeight));

			totalSwitchWeight += switchWeight;

			// See if it's feasible to build up energy before switching
			if(self.hasStrategy("SWITCH_FARM")){
				var dpt = (opponent.fastMove.damage / (opponent.fastMove.cooldown / 500));
				var percentPerTurn = (dpt / pokemon.startHp) * 100; // The opponent's fast attack will deal this % damage per turn
				var weightFactor =  Math.pow(Math.round(Math.max(3 - percentPerTurn, 0)), 2);

				totalSwitchWeight += (switchWeight * weightFactor);
				options.push(new DecisionOption("SWITCH_FARM", switchWeight * weightFactor));
			}
		}

		// If there's a decent chance this Pokemon really shouldn't switch out, add other actions

		if(totalSwitchWeight < 10){
			options.push(new DecisionOption("DEFAULT", 1));

			if((self.hasStrategy("BAIT_SHIELDS"))&&(opponent.shields > 0)){
				var baitWeight = Math.round( (scenarios.bothBait.average - scenarios.noBait.average) / 20);
				options.push(new DecisionOption("BAIT_SHIELDS", baitWeight));
			}

			if(self.hasStrategy("FARM_ENERGY")){
				var farmWeight = Math.round( (scenarios.farm.average - 600) / 20);
				options.push(new DecisionOption("FARM", farmWeight));
			}
		}

		// Decide the AI's operating strategy
		var option = self.chooseOption(options);
		self.processStrategy(option.name);

		if(turn !== undefined){
			turnLastEvaluated = turn;
		} else{
			turnLastEvaluated = 1;
		}
	}

	// Run a specific scenario

	this.runScenario = function(type, pokemon, opponent){
		var scenario = {
			name: type,
			matchups: [],
			average: 0,
			minShields: 3
		};

		// Preserve old Pokemon stats
		var startStats = [
			{
				shields: pokemon.startingShields,
				hp: pokemon.hp,
				energy: pokemon.energy
			},
			{
				shields: opponent.startingShields,
				hp: opponent.hp,
				energy: opponent.energy
			}
		];

		switch(type){
			case "BOTH_BAIT":
				pokemon.baitShields = true;
				pokemon.farmEnergy = false;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;

			case "NEITHER_BAIT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				opponent.baitShields = false;
				opponent.farmEnergy = false;
				break;

			case "NO_BAIT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;

			case "FARM":
				pokemon.baitShields = true;
				pokemon.farmEnergy = true;
				opponent.baitShields = true;
				opponent.farmEnergy = false;
				break;
		}

		var b = new Battle();
		b.setNewPokemon(pokemon, 0, false);
		b.setNewPokemon(opponent, 1, false);

		for(var i = 0; i <= startStats[0].shields; i++){
			for(n = 0; n <= startStats[1].shields; n++){
				pokemon.startingShields = i;
				opponent.startingShields = n;
				b.simulate();

				var rating = b.getBattleRatings()[0];
				scenario.matchups.push(rating);
				scenario.average += rating;

				if((rating >= 500)&&(i < scenario.minShields)){
					scenario.minShields = i;
				}
			}
		}

		scenario.average /= scenario.matchups.length;

		pokemon.startingShields = startStats[0].shields;
		pokemon.startHp = startStats[0].hp;
		pokemon.startEnergy = startStats[0].energy;

		opponent.startingShields = startStats[1].shields;
		opponent.startHp = startStats[1].hp;
		opponent.startEnergy = startStats[1].energy;

		pokemon.reset();
		opponent.reset();
		pokemon.index = 1;
		pokemon.farmEnergy = false;
		opponent.index = 0;
		opponent.farmEnergy = false;

		return scenario;
	}

	// Choose an option from an array
	this.chooseOption = function(options){
		var optionBucket = [];

		// Put all the options in bucket, multiple times for its weight value

		for(var i = 0; i < options.length; i++){
			for(var n = 0; n < options[i].weight; n++){
				optionBucket.push(options[i].name);
			}
		}

		var index = Math.floor(Math.random() * optionBucket.length);
		var optionName = optionBucket[index];
		var option = options.filter(obj => {
			return obj.name === optionName
		})[0];

		return option;
	}

	// Change settings to accomodate a new strategy

	this.processStrategy = function(strategy){
		currentStrategy = strategy;

		var pokemon = battle.getPokemon()[player.getIndex()];

		switch(currentStrategy){
			case "SWITCH_FARM":
				pokemon.farmEnergy = true;
				break;

			case "FARM":
				pokemon.farmEnergy = true;
				break;

			case "DEFAULT":
				pokemon.baitShields = false;
				pokemon.farmEnergy = false;
				break;

			case "BAIT_SHIELDS":
				pokemon.baitShields = true;
				pokemon.farmEnergy = false;
				break;
		}
	}

	this.decideAction = function(turn, poke, opponent){
		var action = null;

		console.log(poke.speciesId + " " + currentStrategy);

		poke.setBattle(battle);
		poke.resetMoves();

		if((currentStrategy.indexOf("SWITCH") > -1) && (player.getSwitchTimer() == 0)){
			var performSwitch = false;

			if((currentStrategy == "SWITCH_BASIC") && (turn - turnLastEvaluated >= props.reactionTime)){
				performSwitch = true;
			}

			if(currentStrategy == "SWITCH_FARM"){
				// Check to see if the opposing Pokemon is close to a damaging Charged Move
				var potentialDamage = self.calculatePotentialDamage(opponent, poke, opponent.energy);

				// How much potential damage with they have after one more Fast Move?

				var extraFastMoves = Math.floor((poke.fastMove.cooldown - opponent.cooldown) / (opponent.fastMove.cooldown))
				var futureEnergy = opponent.energy + (extraFastMoves * opponent.fastMove.energyGain);
				var futureDamage = self.calculatePotentialDamage(opponent, poke, futureEnergy);

				if((futureDamage >= poke.hp)||(futureDamage >= poke.stats.hp * .25)){
					performSwitch = true;
				}

			}

			if(performSwitch){
				// Determine a Pokemon to switch to
				var switchChoice = self.decideSwitch();
				action = new TimelineAction("switch", player.getIndex(), turn, switchChoice, {priority: poke.priority});
			}
		}

		poke.resetMoves(true);

		if(! action){
			action = battle.decideAction(poke, opponent);
		}

		return action;
	}

	// Return the index of a Pokemon to switch to

	this.decideSwitch = function(){
		var switchOptions = [];
		var team = player.getTeam();
		var poke = battle.getPokemon()[player.getIndex()];
		var opponent = battle.getOpponent(player.getIndex());

		for(var i = 0; i < team.length; i++){
			var pokemon = team[i];

			if((pokemon.hp > 0)&&(pokemon != poke)){
				var scenario = self.runScenario("NO_BAIT", pokemon, opponent);
				var weight = Math.round(scenario.average / 100);

				if(scenario.average > 500){
					weight *= 10;
				}

				switchOptions.push(new DecisionOption(i, weight));
			}
		}

		var switchChoice = self.chooseOption(switchOptions);
		return switchChoice.name;
	}

	// Decide whether or not to shield a Charged Attack

	this.decideShield = function(attacker, defender, m){
		// First, how hot are we looking in this current matchup?
		var currentScenario = self.runScenario("NO_BAIT", defender, attacker);
		var currentRating = currentScenario.average;
		var currentHp = defender.hp;
		var estimatedEnergy = defender.energy + (Math.floor(Math.random() * (props.energyGuessRange * 2)) - props.energyGuessRange);
		var potentialDamage = 0;
		var potentialHp = defender.hp - potentialDamage;

		// Which move do we think the attacker is using?
		var moves = [];
		var minimumEnergy = 100;

		for(var i = 0; i < attacker.chargedMoves.length; i++){
			if(minimumEnergy > attacker.chargedMoves[i].energy){
				minimumEnergy = attacker.chargedMoves[i].energy;

				if(estimatedEnergy < minimumEnergy){
					estimatedEnergy = minimumEnergy; // Want to make sure at least one valid move can be guessed
				}
			}


			if(estimatedEnergy >= attacker.chargedMoves[i].energy){
				attacker.chargedMoves.damage = battle.calculateDamage(attacker, defender, attacker.chargedMoves[i], true);
				moves.push(attacker.chargedMoves[i]);
			}
		}

		// Sort moves by damage

		moves.sort((a,b) => (a.damage > b.uses) ? -1 : ((b.uses > a.uses) ? 1 : 0));

		var moveGuessOptions = [];

		for(var i = 0; i < moves.length; i++){
			var moveWeight = 1;
			// Is this the actual move being used? Cheat a little bit and give the AI some heads up
			if(moves[i].name == m.name){
				moveWeight += props.moveGuessCertainty;
			}
			moveGuessOptions.push(new DecisionOption(i, moveWeight));
		}

		var move = moves[self.chooseOption(moveGuessOptions).name]; // The guessed move of the attacker

		// Great! We've guessed the move, now let's analyze if we should shield like a player would
		var yesWeight = 1;
		var noWeight = 1;

		// Will this attack hurt?
		var damageWeight = Math.min(Math.round((move.damage / defender.stats.hp) * 10), 10);

		if(damageWeight > 4){
			damageWeight = damageWeight - 4;
			yesWeight += (damageWeight * 2);
		} else{
			damageWeight = 4 - damageWeight;
			noWeight += damageWeight;
		}

		// Is this move going to knock me out?
		if(move.damage >= defender.hp){
			// How good of a matchup is this for us?
			if(currentRating > 500){
				yesWeight += Math.round((currentRating - 500) / 10)
			} else if(player.getRemainingPokemon() > 1){
				noWeight += Math.round((500 - currentRating) / 10)
			}
		}

		// How many Pokemon do I have left compared to shields?

		if(yesWeight - noWeight > -3){
			yesWeight += (3 - player.getRemainingPokemon()) * 3;
		}

		var options = [];
		options.push(new DecisionOption(true, yesWeight));
		options.push(new DecisionOption(false, noWeight));

		console.log("Yes: " + options[0].weight);
		console.log("No: " + options[1].weight);

		var decision = self.chooseOption(options).name;

		return decision;
	}

	// Given a pokemon and its stored energy, how much potential damage can it deal?

	this.calculatePotentialDamage = function(attacker, defender, energy, stack){
		stack = typeof stack !== 'undefined' ? stack : true;

		var totalDamage = [];

		for(var i = 0; i < attacker.chargedMoves.length; i++){
			var countMultiplier = Math.floor(energy / attacker.chargedMoves[i].energy);
			if(! stack){
				countMultiplier = 0;
				if(attacker.chargedMoves[i].energy <= energy){
					countMultiplier = 1;
				}
			}

			var damage = countMultiplier * battle.calculateDamage(attacker, defender, attacker.chargedMoves[i], true);
			totalDamage.push(damage);
		}

		if(totalDamage.length == 0){
			return 0;
		} else{
			return Math.max.apply(Math, totalDamage);
		}
	}

	// Return whether not this AI can run the provided strategy
	this.hasStrategy = function(strategy){
		return (props.strategies.indexOf(strategy) > -1);
	}

}

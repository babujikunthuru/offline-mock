# Python and Interpreters
Python is a high-level programming language known for readable syntax and a broad standard library. The interpreter executes Python instructions and reports errors during execution, while tools can also compile source into bytecode internally. Indentation marks the structure of blocks, so consistent spacing is part of the program's meaning. For example, a short script can read a text file, count its lines, and print a clear summary without requiring a separate build step.

# Values and Variables
A variable is a name bound to a value, and Python determines the value's type at runtime. Common built-in values include integers, floating-point numbers, strings, booleans, and None. Names should describe the information they refer to, and assignment binds a name to a value. For example, attempts = 3 stores an integer count, while learner_name = "Asha" stores text. Converting between types should be deliberate because invalid conversions can raise exceptions.

# Conditions and Loops
Conditions choose which statements run, and loops repeat a block while processing data. An if and elif chain compares conditions, while for loops iterate over items and while loops continue as long as a condition is true. Python uses indentation to show which statements belong to each block. For example, a for loop can inspect each score and print whether it meets a passing threshold. A while loop should update its condition to avoid running forever.

# Functions
A function is a reusable block of code that can accept arguments and return a result. The def keyword defines a function, and its body is indented. Functions make programs easier to understand by giving a task a name and keeping related steps together. Default parameters can support common cases, while return statements make results available to callers. For example, a normalize_name function can remove extra spaces and return a consistently capitalized name.

# Collections
Collections store multiple values. A list is ordered and mutable, a tuple is ordered and immutable, a set stores unique values, and a dictionary maps keys to values. Choosing a collection based on its behavior makes code clearer and more efficient. For example, a dictionary can map each course code to its title, while a set can remove duplicate tags from imported records. Iteration lets a program process collection values one at a time.

# Modules and Exceptions
A module is a Python file that groups reusable definitions, and import makes those definitions available elsewhere. The standard library provides modules for common tasks, while packages organize related modules. Exceptions signal errors or unusual conditions; try and except blocks can handle failures that a program can recover from. For example, a script can import json to read configuration and catch a file-not-found exception to explain that the configuration file needs to be created.
